/**
 * # Stage 4: Name resolution
 *
 * Name resolution answers "what does this name refer to?" for every path in
 * the program. It runs in three passes:
 *
 * ```mermaid
 * flowchart LR
 *   A["1 · Collect<br/>build the module tree,<br/>give every item a DefId"] --> B["2 · Imports<br/>resolve every use<br/>(fixed-point loop)"] --> C["3 · Bodies<br/>resolve every path in<br/>signatures and bodies"]
 * ```
 *
 * ## 1. Collecting definitions
 *
 * We walk every crate's items and create a {@link Def} for each, inserting it
 * into its module's *type* or *value* namespace (or both, for tuple structs
 * and variants). Items declared inside function bodies go into an
 * *anonymous module* for their block.
 *
 * ## 2. Resolving imports to a fixed point
 *
 * `use` declarations can depend on each other, possibly across modules and
 * crates, and in any textual order:
 *
 * ```rust
 * mod a { pub use crate::b::Thing; }   // needs b's import to be done first
 * mod b { pub use crate::c::Thing; }
 * mod c { pub struct Thing; }
 * ```
 *
 * So we loop: try every unresolved import; each one that succeeds adds a
 * binding, which may let others succeed next round. When a whole round makes no
 * progress, whatever is left is an error (`E0432 unresolved import`).
 *
 * ## 3. Resolving bodies with ribs
 *
 * Inside function bodies, local variables shadow items. We keep a stack of
 * **ribs** (rustc's term): each block, match arm and function pushes a rib of
 * the names it binds. Lookup walks the ribs from innermost to outermost, then
 * falls back to the module's items, then to the standard prelude.
 *
 * ```mermaid
 * flowchart TB
 *   n["lookup 'x'"] --> r3["rib: match arm (y)"] --> r2["rib: block (x ✔)"] --> r1["rib: fn params (a, b)"] --> m["module items"] --> p["std prelude"] --> prim["primitive types"]
 * ```
 *
 * A nested `fn` item gets a *boundary* rib: lookups may not cross it to reach
 * the outer function's locals (`E0434`), because a `fn` is not a closure.
 *
 * ## Privacy
 *
 * A private item is visible in the module that declares it and in that
 * module's descendants. `pub` makes it visible everywhere. Every path that
 * steps through a module checks this (`E0603`).
 */
import { Diagnostics, type Span } from "../diagnostics.ts";
import type { Crate, CrateGraph } from "../crates/loader.ts";
import type * as A from "../parser/ast.ts";
import { patternBindings } from "../parser/visit.ts";
import { isPrim, type Binding, type Def, type DefId, type DefKind, type ModuleScope, type Namespace, type PartialRes, type Res } from "./defs.ts";

export interface ResolveResults {
  defs: Def[];
  /** Crate id → DefId of its root module. */
  crateRoots: DefId[];
  /** `Path.id` → what the path resolved to. */
  paths: Map<A.NodeId, PartialRes>;
  /** Ident patterns that turned out to name an item (like `None`), keyed by pattern id. */
  patternPaths: Map<A.NodeId, PartialRes>;
  /** Item / impl-item node id → its DefId. */
  defOfNode: Map<A.NodeId, DefId>;
  /** Generic param DefIds of an item, in order: `impl<T>` / `fn<U>` / `struct<T>`. */
  genericsOf: Map<DefId, DefId[]>;
  impls: DefId[];
  traits: DefId[];
  /** Well-known standard library items, e.g. `Option`, `Vec`, `Display`. */
  lang: Map<string, DefId>;
  /** The root crate's `main` function, if it is a binary. */
  main?: DefId;
  /** Loop labels: `break 'outer` → the loop expression's node id. */
  labels: Map<A.NodeId, A.NodeId>;
}

interface PendingImport {
  module: DefId;
  path: string[];
  /** For single imports, the name to bind. Undefined for globs. */
  name?: string;
  glob: boolean;
  isPub: boolean;
  span: Span;
  crate: number;
}

/** One level of lexical scope inside a body. */
interface Rib {
  values: Map<string, A.NodeId>;
  types: Map<string, Res>;
  /** Anonymous module for items declared in this block. */
  module?: DefId;
  /** A nested fn item: locals of outer ribs are not reachable. */
  boundary?: boolean;
}

/** Paths into the standard library that the compiler needs to know by name ("lang items"). */
const LANG_PATHS: Record<string, string[]> = {
  Option: ["option", "Option"], Result: ["result", "Result"], Ordering: ["cmp", "Ordering"],
  Vec: ["vec", "Vec"], String: ["string", "String"], Box: ["boxed", "Box"], HashMap: ["collections", "HashMap"],
  Range: ["ops", "Range"], RangeInclusive: ["ops", "RangeInclusive"], Formatter: ["fmt", "Formatter"],
  Clone: ["clone", "Clone"], Copy: ["marker", "Copy"], Default: ["default", "Default"],
  PartialEq: ["cmp", "PartialEq"], Eq: ["cmp", "Eq"], PartialOrd: ["cmp", "PartialOrd"], Ord: ["cmp", "Ord"],
  Debug: ["fmt", "Debug"], Display: ["fmt", "Display"], Hash: ["collections", "Hash"],
  Iterator: ["iter", "Iterator"], IntoIterator: ["iter", "IntoIterator"], ToString: ["string", "ToString"],
  Add: ["ops", "Add"], Sub: ["ops", "Sub"], Mul: ["ops", "Mul"], Div: ["ops", "Div"], Rem: ["ops", "Rem"], Neg: ["ops", "Neg"],
  AddAssign: ["ops", "AddAssign"], SubAssign: ["ops", "SubAssign"], MulAssign: ["ops", "MulAssign"],
  From: ["convert", "From"],
};

/** Derivable traits and where they live. */
export const DERIVABLE = ["Debug", "Clone", "Copy", "PartialEq", "Eq", "PartialOrd", "Ord", "Hash", "Default"];

export function resolve(graph: CrateGraph, diags: Diagnostics): ResolveResults {
  return new Resolver(graph, diags).run();
}

class Resolver {
  private readonly defs: Def[] = [];
  private readonly crateRoots: DefId[] = [];
  private readonly paths = new Map<A.NodeId, PartialRes>();
  private readonly patternPaths = new Map<A.NodeId, PartialRes>();
  private readonly defOfNode = new Map<A.NodeId, DefId>();
  private readonly genericsOf = new Map<DefId, DefId[]>();
  private readonly impls: DefId[] = [];
  private readonly traits: DefId[] = [];
  private readonly labels = new Map<A.NodeId, A.NodeId>();
  private readonly pending: PendingImport[] = [];
  /** Block node id → anonymous module holding that block's items. */
  private readonly blockModules = new Map<A.NodeId, DefId>();
  private preludeModule?: DefId;

  // Body-resolution state.
  private ribs: Rib[] = [];
  private module: DefId = 0;
  private crate!: Crate;
  private labelStack: { name?: string; id: A.NodeId }[] = [];

  private readonly graph: CrateGraph;
  private readonly diags: Diagnostics;

  constructor(graph: CrateGraph, diags: Diagnostics) {
    this.graph = graph;
    this.diags = diags;
  }

  run(): ResolveResults {
    // Pass 1: collect.
    for (const crateId of this.graph.order) {
      const crate = this.graph.crates[crateId];
      const root = this.newDef("mod", crate.name, crate.id, undefined, undefined, true, { file: crate.rootFile, start: 0, end: 0 });
      this.defs[root].scope = newScope();
      this.defs[root].module = root;
      this.crateRoots[crate.id] = root;
      this.collectItems(crate.items, root, crate);
    }
    const stdRoot = this.crateRoots[this.graph.std];
    const prelude = this.defs[stdRoot].scope!.types.get("prelude");
    if (prelude?.res.kind === "def") this.preludeModule = prelude.res.def;

    // Pass 2: imports.
    this.resolveImports();

    // Lang items.
    const lang = new Map<string, DefId>();
    for (const [name, path] of Object.entries(LANG_PATHS)) {
      const mod = this.defs[stdRoot].scope!.types.get(path[0]);
      const item = mod?.res.kind === "def" ? this.defs[mod.res.def].scope?.types.get(path[1]) : undefined;
      if (item?.res.kind === "def") lang.set(name, item.res.def);
    }

    // Pass 3: bodies.
    for (const crateId of this.graph.order) {
      this.crate = this.graph.crates[crateId];
      this.resolveItems(this.crate.items, this.crateRoots[crateId]);
    }

    // Find `fn main`.
    let main: DefId | undefined;
    const rootCrate = this.graph.crates[this.graph.root];
    if (rootCrate.kind === "bin") {
      const b = this.defs[this.crateRoots[rootCrate.id]].scope!.values.get("main");
      if (b?.res.kind === "def" && this.defs[b.res.def].kind === "fn") main = b.res.def;
      else this.diags.error("resolve", { file: rootCrate.rootFile, start: 0, end: 0 }, `\`main\` function not found in crate \`${rootCrate.name}\``, "E0601")
        .help("add `fn main() { }` to the crate root");
    }

    return {
      defs: this.defs, crateRoots: this.crateRoots, paths: this.paths, patternPaths: this.patternPaths,
      defOfNode: this.defOfNode, genericsOf: this.genericsOf, impls: this.impls, traits: this.traits,
      lang, main, labels: this.labels,
    };
  }

  // =========================================================================
  // Pass 1: collect definitions
  // =========================================================================

  private newDef(kind: DefKind, name: string, crate: number, parent: DefId | undefined, node: Def["node"], isPub: boolean, span: Span): DefId {
    const id = this.defs.length;
    this.defs.push({ id, kind, name, crate, parent, module: parent ?? id, isPub, span, node });
    if (node) this.defOfNode.set(node.id, id);
    return id;
  }

  private define(scope: ModuleScope, ns: Namespace, name: string, binding: Binding) {
    const map = ns === "type" ? scope.types : scope.values;
    const prev = map.get(name);
    if (prev && !(prev.res.kind === "def" && binding.res.kind === "def" && prev.res.def === binding.res.def)) {
      this.diags.error("resolve", binding.span, `the name \`${name}\` is defined multiple times`, "E0428")
        .label(prev.span, `previous definition of \`${name}\` here`)
        .note(`\`${name}\` must be defined only once in the ${ns} namespace of this module`);
      return;
    }
    map.set(name, binding);
  }

  /** Create DefIds for generic params and remember them in order. */
  private collectGenerics(owner: DefId, generics: A.Generics, crate: number) {
    const params: DefId[] = [];
    generics.params.forEach((p, i) => {
      const id = this.newDef("tyParam", p.name, crate, owner, undefined, false, p.span);
      this.defs[id].paramIndex = i;
      this.defs[id].bounds = p.bounds;
      this.defs[id].module = this.defs[owner].module;
      params.push(id);
    });
    this.genericsOf.set(owner, params);
  }

  private collectItems(items: A.Item[], module: DefId, crate: Crate) {
    const scope = this.defs[module].scope!;
    for (const item of items) {
      const def = (kind: DefKind, name: string, isPub: boolean, span: Span) => {
        const id = this.newDef(kind, name, crate.id, module, item, isPub, span);
        this.defs[id].module = module;
        return id;
      };
      switch (item.kind) {
        case "fn": {
          const id = def("fn", item.name, item.isPub, item.nameSpan);
          this.collectGenerics(id, item.generics, crate.id);
          this.markIntrinsic(id, item, crate);
          this.define(scope, "value", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false });
          this.collectBodyItems(item.body, module, crate);
          break;
        }
        case "struct": {
          const id = def("struct", item.name, item.isPub, item.nameSpan);
          this.collectGenerics(id, item.generics, crate.id);
          const b: Binding = { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false };
          this.define(scope, "type", item.name, b);
          // Tuple and unit structs also name their constructor in the value namespace.
          if (item.fieldsKind !== "named") this.define(scope, "value", item.name, b);
          this.checkDerives(item.derives, item.span);
          break;
        }
        case "enum": {
          const id = def("enum", item.name, item.isPub, item.nameSpan);
          this.collectGenerics(id, item.generics, crate.id);
          const enumScope = newScope();
          this.defs[id].scope = enumScope;
          item.variants.forEach((v, i) => {
            const vid = this.newDef("variant", v.name, crate.id, id, undefined, true, v.span);
            this.defs[vid].node = item;
            this.defs[vid].variant = v;
            this.defs[vid].variantIndex = i;
            this.defs[vid].module = module;
            const b: Binding = { res: { kind: "def", def: vid }, isPub: true, span: v.span, isImport: false };
            this.define(enumScope, "type", v.name, b);
            this.define(enumScope, "value", v.name, b);
          });
          this.define(scope, "type", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false });
          this.checkDerives(item.derives, item.span);
          break;
        }
        case "trait": {
          const id = def("trait", item.name, item.isPub, item.nameSpan);
          this.traits.push(id);
          this.collectGenerics(id, item.generics, crate.id);
          for (const fn of item.items) {
            const fid = this.newDef("fn", fn.name, crate.id, id, fn, true, fn.nameSpan);
            this.defs[fid].module = module;
            this.collectGenerics(fid, fn.generics, crate.id);
            this.collectBodyItems(fn.body, module, crate);
          }
          for (const ty of item.assocTypes) {
            const tid = this.newDef("assocTy", ty.name, crate.id, id, ty, true, ty.nameSpan);
            this.defs[tid].module = module;
          }
          this.define(scope, "type", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false });
          break;
        }
        case "impl": {
          const id = def("impl", "<impl>", true, item.span);
          this.impls.push(id);
          this.collectGenerics(id, item.generics, crate.id);
          for (const fn of item.items) {
            const fid = this.newDef("fn", fn.name, crate.id, id, fn, fn.isPub || !!item.traitPath, fn.nameSpan);
            this.defs[fid].module = module;
            this.collectGenerics(fid, fn.generics, crate.id);
            this.markIntrinsic(fid, fn, crate);
            this.collectBodyItems(fn.body, module, crate);
          }
          for (const ty of item.assocTypes) {
            const tid = this.newDef("typeAlias", ty.name, crate.id, id, ty, true, ty.nameSpan);
            this.defs[tid].module = module;
          }
          for (const c of item.consts) {
            const cid = this.newDef("const", c.name, crate.id, id, c, c.isPub, c.nameSpan);
            this.defs[cid].module = module;
          }
          break;
        }
        case "mod": {
          const id = def("mod", item.name, item.isPub, item.span);
          this.defs[id].scope = newScope();
          this.defs[id].module = id;
          this.define(scope, "type", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.span, isImport: false });
          this.collectItems(item.items ?? [], id, crate);
          break;
        }
        case "const": {
          const id = def("const", item.name, item.isPub, item.nameSpan);
          this.define(scope, "value", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false });
          break;
        }
        case "type": {
          const id = def("typeAlias", item.name, item.isPub, item.nameSpan);
          this.collectGenerics(id, item.generics, crate.id);
          this.define(scope, "type", item.name, { res: { kind: "def", def: id }, isPub: item.isPub, span: item.nameSpan, isImport: false });
          break;
        }
        case "use":
          this.collectUse(item.tree, [], module, item.isPub, crate.id);
          break;
      }
    }
  }

  private markIntrinsic(id: DefId, fn: A.FnItem, crate: Crate) {
    if (fn.body) return;
    if (crate.isStd) this.defs[id].intrinsic = true;
    else this.diags.error("resolve", fn.nameSpan, `free function without a body`)
      .help(`provide a definition for the function: \`{ ... }\``);
  }

  private checkDerives(derives: string[], span: Span) {
    for (const d of derives) {
      if (!DERIVABLE.includes(d)) {
        this.diags.error("resolve", span, `cannot find derive macro \`${d}\` in this scope`)
          .note(`TSRust can derive: ${DERIVABLE.join(", ")}`);
      }
    }
  }

  /**
   * Items can be declared inside function bodies. Find every block that has
   * item statements and give it an anonymous module.
   */
  private collectBodyItems(body: A.BlockExpr | undefined, parent: DefId, crate: Crate) {
    if (!body) return;
    const visit = (e: A.Expr) => {
      if (e.kind === "block" && e.stmts.some((s) => s.kind === "item")) {
        const id = this.newDef("mod", "{block}", crate.id, parent, undefined, false, e.span);
        this.defs[id].scope = newScope();
        this.defs[id].module = id;
        this.blockModules.set(e.id, id);
        this.collectItems(e.stmts.flatMap((s) => (s.kind === "item" ? [s.item] : [])), id, crate);
      }
      forEachChild(e, visit);
    };
    visit(body);
  }

  private collectUse(tree: A.UseTree, prefix: string[], module: DefId, isPub: boolean, crate: number) {
    const path = [...prefix, ...tree.path];
    if (tree.kind === "nested") {
      for (const t of tree.trees) this.collectUse(t, path, module, isPub, crate);
    } else if (tree.kind === "glob") {
      this.pending.push({ module, path, glob: true, isPub, span: tree.span, crate });
    } else {
      // `use a::b::{self}` imports `b` itself.
      const isSelf = path[path.length - 1] === "self" && path.length > 1;
      const target = isSelf ? path.slice(0, -1) : path;
      const name = tree.alias ?? target[target.length - 1];
      this.pending.push({ module, path: target, name, glob: false, isPub, span: tree.span, crate });
    }
  }

  // =========================================================================
  // Pass 2: imports
  // =========================================================================

  private resolveImports() {
    let remaining = [...this.pending];
    while (remaining.length) {
      const next: PendingImport[] = [];
      for (const imp of remaining) if (!this.tryImport(imp, false)) next.push(imp);
      if (next.length === remaining.length) {
        // No progress: report the leftovers.
        for (const imp of next) this.tryImport(imp, true);
        return;
      }
      remaining = next;
    }
  }

  /** Try to resolve one import. With `report`, emit the error explaining why it failed. */
  private tryImport(imp: PendingImport, report: boolean): boolean {
    const scope = this.defs[imp.module].scope!;
    if (imp.glob) {
      const target = this.resolveModulePath(imp.path, imp.module, imp.crate, report ? imp.span : undefined);
      if (target === undefined) return false;
      const kind = this.defs[target].kind;
      if (kind !== "mod" && kind !== "enum") {
        if (report) this.diags.error("resolve", imp.span, `\`${imp.path.join("::")}\` is not a module or enum; it can't be glob-imported`);
        return report;
      }
      scope.globs.push({ target, isPub: imp.isPub });
      return true;
    }
    const prefix = imp.path.slice(0, -1);
    const last = imp.path[imp.path.length - 1];
    let found = false;
    if (prefix.length === 0) {
      // `use foo;` where foo is an extern crate.
      const ext = this.crateDep(imp.crate, last);
      if (ext !== undefined) {
        this.define(scope, "type", imp.name!, { res: { kind: "def", def: ext }, isPub: imp.isPub, span: imp.span, isImport: true });
        return true;
      }
      if (report) this.diags.error("resolve", imp.span, `unresolved import \`${last}\``, "E0432")
        .help(`paths in \`use\` start with a crate name, \`crate\`, \`self\` or \`super\``);
      return report;
    }
    const container = this.resolveModulePath(prefix, imp.module, imp.crate, report ? imp.span : undefined);
    if (container === undefined) return false;
    for (const ns of ["type", "value"] as Namespace[]) {
      const b = this.lookupInScope(container, last, ns, imp.module, new Set());
      if (b) {
        found = true;
        if (!this.isAccessible(b, container, imp.module)) {
          this.reportPrivate(last, b, imp.span);
        }
        this.define(scope, ns, imp.name!, { res: b.res, isPub: imp.isPub, span: imp.span, isImport: true });
      }
    }
    if (!found && report) {
      this.diags.error("resolve", imp.span, `unresolved import \`${imp.path.join("::")}\``, "E0432")
        .label(imp.span, `no \`${last}\` in \`${prefix.join("::")}\``);
    }
    return found || report;
  }

  /** Resolve a `use`-style path of modules (or an enum), returning the final DefId. */
  private resolveModulePath(path: string[], from: DefId, crate: number, reportSpan: Span | undefined): DefId | undefined {
    let current: DefId | undefined;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      let next: DefId | undefined;
      if (i === 0) next = this.resolveFirstModuleSegment(seg, from, crate);
      else if (seg === "super") next = this.parentModule(current!);
      else if (seg === "self") next = current;
      else {
        const b = this.lookupInScope(current!, seg, "type", from, new Set());
        if (b?.res.kind === "def") {
          if (!this.isAccessible(b, current!, from)) this.reportPrivate(seg, b, reportSpan ?? b.span);
          next = b.res.def;
        }
      }
      if (next === undefined || !this.defs[next].scope) {
        if (reportSpan) {
          this.diags.error("resolve", reportSpan, `failed to resolve: could not find \`${seg}\` in \`${i === 0 ? "this scope" : path.slice(0, i).join("::")}\``, "E0433");
        }
        return undefined;
      }
      current = next;
    }
    return current;
  }

  private resolveFirstModuleSegment(seg: string, from: DefId, crate: number): DefId | undefined {
    if (seg === "crate") return this.crateRoots[crate];
    if (seg === "self") return this.nearestNamedModule(from);
    if (seg === "super") return this.parentModule(this.nearestNamedModule(from));
    const local = this.lookupInScope(from, seg, "type", from, new Set());
    if (local?.res.kind === "def") return local.res.def;
    return this.crateDep(crate, seg);
  }

  private crateDep(crate: number, name: string): DefId | undefined {
    const c = this.graph.crates[crate];
    const depId = c.deps.get(name);
    if (depId !== undefined) return this.crateRoots[depId];
    if (name === c.name) return undefined;
    return undefined;
  }

  /** Skip anonymous block modules. */
  private nearestNamedModule(m: DefId): DefId {
    while (this.defs[m].name === "{block}" && this.defs[m].parent !== undefined) m = this.defs[m].parent!;
    return m;
  }

  private parentModule(m: DefId): DefId | undefined {
    const named = this.nearestNamedModule(m);
    const p = this.defs[named].parent;
    return p === undefined ? undefined : this.nearestNamedModule(p);
  }

  /**
   * Look up `name` directly in a module or enum scope: first explicit items and
   * imports, then glob imports (which have lower priority).
   */
  private lookupInScope(container: DefId, name: string, ns: Namespace, from: DefId, visiting: Set<DefId>): Binding | undefined {
    const scope = this.defs[container].scope;
    if (!scope || visiting.has(container)) return undefined;
    const direct = (ns === "type" ? scope.types : scope.values).get(name);
    if (direct) return direct;
    visiting.add(container);
    for (const glob of scope.globs) {
      const b = this.lookupInScope(glob.target, name, ns, from, visiting);
      // Globs only bring in names visible to the importing module.
      if (b && this.isAccessible(b, glob.target, container)) return { ...b, isPub: b.isPub && glob.isPub, isImport: true };
    }
    return undefined;
  }

  /** Is `binding`, which lives in `container`, accessible from module `from`? */
  private isAccessible(binding: Binding, container: DefId, from: DefId): boolean {
    if (binding.isPub || this.defs[container].kind === "enum") return true;
    // Private: visible in `container` and its descendants.
    const owner = this.nearestNamedModule(container);
    for (let m: DefId | undefined = from; m !== undefined; m = this.defs[m].parent) {
      if (m === owner) return true;
      if (this.defs[m].kind !== "mod") break;
    }
    return false;
  }

  private reportPrivate(name: string, b: Binding, span: Span) {
    const kind = b.res.kind === "def" ? describeKind(this.defs[b.res.def].kind) : "item";
    this.diags.error("resolve", span, `${kind} \`${name}\` is private`, "E0603")
      .label(b.span, `the ${kind} \`${name}\` is defined here`)
      .help(`mark it \`pub\` to make it visible outside its module`);
  }

  // =========================================================================
  // Pass 3: signatures and bodies
  // =========================================================================

  private resolveItems(items: A.Item[], module: DefId) {
    const savedModule = this.module;
    const savedRibs = this.ribs;
    this.module = module;
    for (const item of items) this.resolveItem(item);
    this.module = savedModule;
    this.ribs = savedRibs;
  }

  /** A rib holding an item's generic params (and possibly `Self`). */
  private genericRib(owner: DefId, selfRes?: Res): Rib {
    const rib: Rib = { values: new Map(), types: new Map(), boundary: true };
    for (const p of this.genericsOf.get(owner) ?? []) rib.types.set(this.defs[p].name, { kind: "def", def: p });
    if (selfRes) rib.types.set("Self", selfRes);
    return rib;
  }

  private withRibs<T>(ribs: Rib[], f: () => T): T {
    const saved = this.ribs;
    this.ribs = [...this.ribs, ...ribs];
    try {
      return f();
    } finally {
      this.ribs = saved;
    }
  }

  private resolveGenericBounds(generics: A.Generics) {
    for (const p of generics.params) {
      for (const b of p.bounds) this.resolveTraitPath(b);
      if (p.default) this.resolveType(p.default);
    }
  }

  private resolveItem(item: A.Item) {
    const id = this.defOfNode.get(item.id);
    switch (item.kind) {
      case "fn":
        this.withRibs([this.genericRib(id!)], () => this.resolveFn(item));
        break;
      case "struct":
        this.withRibs([this.genericRib(id!, { kind: "def", def: id! })], () => {
          this.resolveGenericBounds(item.generics);
          for (const f of item.fields) this.resolveType(f.ty);
        });
        break;
      case "enum":
        this.withRibs([this.genericRib(id!, { kind: "def", def: id! })], () => {
          this.resolveGenericBounds(item.generics);
          for (const v of item.variants) for (const f of v.fields) this.resolveType(f.ty);
        });
        break;
      case "trait":
        this.withRibs([this.genericRib(id!, { kind: "selfTy", owner: id! })], () => {
          this.resolveGenericBounds(item.generics);
          for (const s of item.supertraits) this.resolveTraitPath(s);
          for (const fn of item.items) {
            const fid = this.defOfNode.get(fn.id)!;
            this.withRibs([this.genericRib(fid)], () => this.resolveFn(fn));
          }
        });
        break;
      case "impl":
        this.withRibs([this.genericRib(id!, { kind: "selfTy", owner: id! })], () => {
          this.resolveGenericBounds(item.generics);
          this.resolveType(item.selfTy);
          if (item.traitPath) this.resolveTraitPath(item.traitPath);
          for (const ty of item.assocTypes) if (ty.ty) this.resolveType(ty.ty);
          for (const c of item.consts) {
            this.resolveType(c.ty);
            this.resolveExpr(c.value);
          }
          for (const fn of item.items) {
            const fid = this.defOfNode.get(fn.id)!;
            this.withRibs([this.genericRib(fid)], () => this.resolveFn(fn));
          }
        });
        break;
      case "mod":
        this.resolveItems(item.items ?? [], id!);
        break;
      case "const":
        this.resolveType(item.ty);
        this.resolveExpr(item.value);
        break;
      case "type":
        this.withRibs([this.genericRib(id!)], () => {
          if (item.ty) this.resolveType(item.ty);
        });
        break;
      case "use":
        break;
    }
  }

  private resolveFn(fn: A.FnItem) {
    this.resolveGenericBounds(fn.generics);
    const paramRib: Rib = { values: new Map(), types: new Map() };
    for (const p of fn.params) this.resolveType(p.ty);
    if (fn.ret) this.resolveType(fn.ret);
    this.withRibs([paramRib], () => {
      const seen = new Map<string, Span>();
      if (fn.selfParam) paramRib.values.set("self", fn.selfParam.id);
      for (const p of fn.params) this.bindPattern(p.pat, paramRib, seen);
      if (fn.body) {
        const savedLabels = this.labelStack;
        this.labelStack = [];
        this.resolveBlock(fn.body);
        this.labelStack = savedLabels;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  /** Lexical lookup of a single name: ribs → block modules → module → extern crates → prelude → primitives. */
  private lookupLexical(name: string, ns: Namespace): Res | undefined {
    let crossedBoundary = false;
    for (let i = this.ribs.length - 1; i >= 0; i--) {
      const rib = this.ribs[i];
      if (ns === "value") {
        const local = rib.values.get(name);
        if (local !== undefined) {
          if (crossedBoundary) return undefined; // reported by the caller as E0434
          return { kind: "local", id: local };
        }
      } else {
        const t = rib.types.get(name);
        if (t) return t;
      }
      if (rib.module !== undefined) {
        const b = this.lookupInScope(rib.module, name, ns, rib.module, new Set());
        if (b) return b.res;
      }
      if (rib.boundary) crossedBoundary = true;
    }
    // The current module, then (for anonymous block modules) the modules enclosing it.
    for (let m: DefId | undefined = this.module; m !== undefined; m = this.defs[m].name === "{block}" ? this.defs[m].parent : undefined) {
      const b = this.lookupInScope(m, name, ns, this.module, new Set());
      if (b) return b.res;
    }
    if (ns === "type") {
      const ext = this.crateDep(this.crate.id, name);
      if (ext !== undefined) return { kind: "def", def: ext };
    }
    if (this.preludeModule !== undefined) {
      const p = this.lookupInScope(this.preludeModule, name, ns, this.preludeModule, new Set());
      if (p) return p.res;
    }
    if (ns === "type" && isPrim(name)) return { kind: "prim", name };
    return undefined;
  }

  /** Did `name` exist as a local beyond a fn boundary? Used to explain E0434. */
  private isCapturedLocal(name: string): boolean {
    return this.ribs.some((r) => r.values.has(name));
  }

  /**
   * Resolve a path. All segments but the last are looked up in the type
   * namespace; the last in `ns`. Resolution stops early at a type (struct,
   * enum used as a type, trait, generic param, primitive, `Self`), leaving the
   * remaining segments for the type checker.
   */
  private resolvePath(path: A.Path, ns: Namespace): PartialRes | undefined {
    const segs = path.segments;
    let res: Res | undefined;
    let i = 0;
    const first = segs[0];
    const firstNs: Namespace = segs.length === 1 ? ns : "type";
    if (first.name === "crate") res = { kind: "def", def: this.crateRoots[this.crate.id] };
    else if (first.name === "self" && segs.length > 1) res = { kind: "def", def: this.nearestNamedModule(this.module) };
    else if (first.name === "super") {
      const p = this.parentModule(this.module);
      if (p === undefined) {
        this.diags.error("resolve", first.span, "there are too many leading `super` keywords", "E0433");
        return undefined;
      }
      res = { kind: "def", def: p };
    } else {
      res = this.lookupLexical(first.name, firstNs);
    }
    if (!res) {
      this.reportUnresolved(path, 0, firstNs);
      return undefined;
    }
    for (i = 1; i < segs.length; i++) {
      if (res.kind !== "def") break;
      const def = this.defs[res.def];
      if (!def.scope) break; // a type: the rest is type-relative
      const seg = segs[i];
      if (seg.name === "super") {
        const p = this.parentModule(res.def);
        if (p === undefined) { this.reportUnresolved(path, i, ns); return undefined; }
        res = { kind: "def", def: p };
        continue;
      }
      const segNs: Namespace = i === segs.length - 1 ? ns : "type";
      let b = this.lookupInScope(res.def, seg.name, segNs, this.module, new Set());
      // `Enum::Variant` with a struct-like variant, looked up in the value namespace, lives in types too.
      if (!b && segNs === "value") b = this.lookupInScope(res.def, seg.name, "type", this.module, new Set());
      if (!b) {
        // An enum or module path that doesn't contain the name.
        if (def.kind === "enum") {
          this.diags.error("resolve", seg.span, `no variant named \`${seg.name}\` found for enum \`${def.name}\``, "E0599");
          return undefined;
        }
        this.reportUnresolved(path, i, segNs);
        return undefined;
      }
      if (!this.isAccessible(b, res.def, this.module)) this.reportPrivate(seg.name, b, seg.span);
      res = b.res;
    }
    const pr: PartialRes = { base: res, unresolved: segs.slice(i), baseIndex: i - 1 };
    this.paths.set(path.id, pr);
    return pr;
  }

  private reportUnresolved(path: A.Path, index: number, ns: Namespace) {
    const seg = path.segments[index];
    const where = index === 0 ? "this scope" : `\`${path.segments.slice(0, index).map((s) => s.name).join("::")}\``;
    if (index === 0 && ns === "value" && path.segments.length === 1 && this.isCapturedLocal(seg.name)) {
      this.diags.error("resolve", seg.span, `can't capture dynamic environment in a fn item`, "E0434")
        .help("use a closure instead (TSRust doesn't support closures yet), or pass the value as a parameter");
      return;
    }
    if (index < path.segments.length - 1 || ns === "type") {
      const what = ns === "type" && index === path.segments.length - 1 ? "type" : "module or type";
      this.diags.error("resolve", seg.span, `cannot find ${what} \`${seg.name}\` in ${where}`, ns === "type" ? "E0412" : "E0433");
    } else {
      this.diags.error("resolve", seg.span, `cannot find value \`${seg.name}\` in ${where}`, "E0425");
    }
  }

  private resolveTraitPath(path: A.Path) {
    const pr = this.resolvePath(path, "type");
    if (pr && (pr.unresolved.length > 0 || pr.base.kind !== "def" || this.defs[pr.base.def].kind !== "trait")) {
      this.diags.error("resolve", path.span, `expected trait, found ${pr.base.kind === "def" ? describeKind(this.defs[pr.base.def].kind) : "type"} \`${path.segments.map((s) => s.name).join("::")}\``, "E0404");
    }
    for (const seg of path.segments) {
      seg.generics?.forEach((g) => this.resolveType(g));
      seg.bindings?.forEach((b) => this.resolveType(b.ty));
    }
  }

  resolveType(ty: A.TypeExpr): void {
    switch (ty.kind) {
      case "path": {
        this.resolvePath(ty.path, "type");
        for (const seg of ty.path.segments) seg.generics?.forEach((g) => this.resolveType(g));
        break;
      }
      case "ref": this.resolveType(ty.inner); break;
      case "tuple": ty.elems.forEach((e) => this.resolveType(e)); break;
      case "qpath": this.resolveType(ty.self); this.resolveTraitPath(ty.trait); break;
      case "infer": case "never": break;
    }
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  /**
   * Resolve the paths inside a pattern and add its bindings to `rib`.
   * `seen` catches `(x, x)` (E0416).
   */
  private bindPattern(p: A.Pattern, rib: Rib, seen: Map<string, Span>) {
    switch (p.kind) {
      case "ident": {
        // Is this actually a unit variant, unit struct or constant (e.g. `None`)?
        if (!p.mutable && !p.byRef && !p.sub) {
          const res = this.lookupLexical(p.name, "value");
          if (res?.kind === "def") {
            const d = this.defs[res.def];
            const isUnitLike =
              d.kind === "const" ||
              (d.kind === "variant" && d.variant!.fieldsKind === "unit") ||
              (d.kind === "struct" && (d.node as A.StructItem).fieldsKind === "unit");
            if (isUnitLike) {
              this.patternPaths.set(p.id, { base: res, unresolved: [], baseIndex: 0 });
              return;
            }
          }
        }
        if (seen.has(p.name)) {
          this.diags.error("resolve", p.span, `identifier \`${p.name}\` is bound more than once in the same pattern`, "E0416")
            .label(seen.get(p.name)!, "first bound here");
        }
        seen.set(p.name, p.span);
        rib.values.set(p.name, p.id);
        if (p.sub) this.bindPattern(p.sub, rib, seen);
        break;
      }
      case "wild": case "lit": case "range": break;
      case "tuple": p.elems.forEach((e) => this.bindPattern(e, rib, seen)); break;
      case "ref": this.bindPattern(p.inner, rib, seen); break;
      case "path": this.resolvePath(p.path, "value"); break;
      case "tupleStruct":
        this.resolvePath(p.path, "value");
        p.elems.forEach((e) => this.bindPattern(e, rib, seen));
        break;
      case "struct":
        this.resolvePath(p.path, "type");
        p.fields.forEach((f) => this.bindPattern(f.pat, rib, seen));
        break;
      case "or": {
        // Every alternative must bind the same names (E0408).
        const names: Set<string>[] = [];
        for (const alt of p.alts) {
          const altSeen = new Map(seen);
          this.bindPattern(alt, rib, altSeen);
          names.push(new Set(patternBindings(alt).filter((b) => !this.patternPaths.has(b.id)).map((b) => (b as { name: string }).name)));
        }
        for (let i = 1; i < names.length; i++) {
          for (const n of new Set([...names[0], ...names[i]])) {
            if (!names[0].has(n) || !names[i].has(n)) {
              this.diags.error("resolve", p.alts[i].span, `variable \`${n}\` is not bound in all patterns`, "E0408");
            }
          }
        }
        for (const n of names[0]) seen.set(n, p.span);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private resolveBlock(block: A.BlockExpr) {
    const rib: Rib = { values: new Map(), types: new Map(), module: this.blockModules.get(block.id) };
    this.withRibs([rib], () => {
      for (const s of block.stmts) {
        if (s.kind === "let") {
          if (s.ty) this.resolveType(s.ty);
          if (s.init) this.resolveExpr(s.init);
          // A `let` starts a new scope: later statements see the binding, the
          // initializer does not. Shadowing just overwrites the map entry.
          const letRib: Rib = { values: new Map(), types: new Map() };
          this.bindPattern(s.pat, letRib, new Map());
          this.ribs.push(letRib);
        } else if (s.kind === "expr") {
          this.resolveExpr(s.expr);
        }
      }
      if (block.tail) this.resolveExpr(block.tail);
      // Resolve nested items last, so the boundary rib can explain captures (E0434).
      if (rib.module !== undefined) {
        const saved = this.module;
        const savedRibs = this.ribs;
        this.module = rib.module;
        // Nested items cannot see the enclosing function's locals or generics:
        // a boundary rib blocks local lookups (reported as E0434).
        this.ribs = [...savedRibs.map((r) => ({ ...r, types: new Map<string, Res>() })), { values: new Map(), types: new Map(), boundary: true }];
        for (const s of block.stmts) if (s.kind === "item") this.resolveItem(s.item);
        this.module = saved;
        this.ribs = savedRibs;
      }
    });
  }

  private resolveExpr(e: A.Expr): void {
    switch (e.kind) {
      case "path":
        this.resolvePath(e.path, "value");
        for (const seg of e.path.segments) seg.generics?.forEach((g) => this.resolveType(g));
        return;
      case "structLit":
        this.resolvePath(e.path, "type");
        for (const seg of e.path.segments) seg.generics?.forEach((g) => this.resolveType(g));
        e.fields.forEach((f) => this.resolveExpr(f.value));
        if (e.base) this.resolveExpr(e.base);
        return;
      case "block":
        this.resolveBlock(e);
        return;
      case "match":
        this.resolveExpr(e.scrutinee);
        for (const arm of e.arms) {
          const rib: Rib = { values: new Map(), types: new Map() };
          this.bindPattern(arm.pat, rib, new Map());
          this.withRibs([rib], () => {
            if (arm.guard) this.resolveExpr(arm.guard);
            this.resolveExpr(arm.body);
          });
        }
        return;
      case "for": {
        this.resolveExpr(e.iter);
        const rib: Rib = { values: new Map(), types: new Map() };
        this.bindPattern(e.pat, rib, new Map());
        this.withLabel(e.label, e.id, () => this.withRibs([rib], () => this.resolveBlock(e.body)));
        return;
      }
      case "while":
        this.withLabel(e.label, e.id, () => {
          this.resolveExpr(e.cond);
          this.resolveBlock(e.body);
        });
        return;
      case "loop":
        this.withLabel(e.label, e.id, () => this.resolveBlock(e.body));
        return;
      case "break":
      case "continue":
        this.resolveLabel(e);
        if (e.kind === "break" && e.value) this.resolveExpr(e.value);
        return;
      case "cast":
        this.resolveExpr(e.expr);
        this.resolveType(e.ty);
        return;
      case "methodCall":
        this.resolveExpr(e.receiver);
        e.generics?.forEach((g) => this.resolveType(g));
        e.args.forEach((a) => this.resolveExpr(a));
        return;
      default:
        forEachChild(e, (c) => this.resolveExpr(c));
    }
  }

  private withLabel(name: string | undefined, id: A.NodeId, f: () => void) {
    this.labelStack.push({ name, id });
    f();
    this.labelStack.pop();
  }

  /** Bind `break`/`continue` to their loop, checking labels exist (E0426) and that we're in a loop (E0268). */
  private resolveLabel(e: Extract<A.Expr, { kind: "break" | "continue" }>) {
    if (e.label) {
      const target = [...this.labelStack].reverse().find((l) => l.name === e.label);
      if (!target) {
        this.diags.error("resolve", e.span, `use of undeclared label \`'${e.label}\``, "E0426");
        return;
      }
      this.labels.set(e.id, target.id);
    } else {
      const target = this.labelStack[this.labelStack.length - 1];
      if (!target) {
        this.diags.error("resolve", e.span, `\`${e.kind}\` outside of a loop`, "E0268");
        return;
      }
      this.labels.set(e.id, target.id);
    }
  }
}

function newScope(): ModuleScope {
  return { types: new Map(), values: new Map(), globs: [] };
}

function describeKind(kind: DefKind): string {
  switch (kind) {
    case "mod": return "module";
    case "fn": return "function";
    case "tyParam": return "type parameter";
    case "typeAlias": return "type alias";
    case "assocTy": return "associated type";
    default: return kind;
  }
}

/** Visit direct child expressions, without descending into nested items. */
function forEachChild(e: A.Expr, f: (c: A.Expr) => void) {
  switch (e.kind) {
    case "lit": case "path": case "continue": return;
    case "unary": case "ref": case "cast": case "try": case "field": f(e.expr); return;
    case "binary": f(e.left); f(e.right); return;
    case "assign": f(e.target); f(e.value); return;
    case "call": f(e.callee); e.args.forEach(f); return;
    case "methodCall": f(e.receiver); e.args.forEach(f); return;
    case "index": f(e.expr); f(e.index); return;
    case "structLit": e.fields.forEach((x) => f(x.value)); if (e.base) f(e.base); return;
    case "tuple": e.elems.forEach(f); return;
    case "block":
      for (const s of e.stmts) {
        if (s.kind === "let" && s.init) f(s.init);
        else if (s.kind === "expr") f(s.expr);
      }
      if (e.tail) f(e.tail);
      return;
    case "if": f(e.cond); f(e.then); if (e.else) f(e.else); return;
    case "while": f(e.cond); f(e.body); return;
    case "loop": f(e.body); return;
    case "for": f(e.iter); f(e.body); return;
    case "break": case "return": if (e.value) f(e.value); return;
    case "match": f(e.scrutinee); for (const a of e.arms) { if (a.guard) f(a.guard); f(a.body); } return;
    case "range": if (e.start) f(e.start); if (e.end) f(e.end); return;
    case "macro": e.args.forEach(f); e.format?.args.forEach(f); return;
  }
}
