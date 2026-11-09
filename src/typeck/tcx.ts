/**
 * # The type context: item signatures
 *
 * Before checking any function *body*, we need the *signature* of every item:
 * the parameter and return types of each function, the field types of each
 * struct, the self type of each impl, the bounds on each generic parameter.
 * rustc calls these queries `fn_sig`, `type_of`, `predicates_of` ...; here
 * they are methods on {@link TyCtxt}, computed lazily and cached.
 *
 * Signatures never need inference: Rust requires full type annotations on
 * items. That's a deliberate design choice — it keeps inference *local* to a
 * single function body, so a change inside one function can't change the
 * inferred types of another.
 *
 * ## Generics and predicates
 *
 * Every item knows its generic parameters, *including those of its parents*:
 *
 * ```rust
 * impl<T: Clone> Wrapper<T> {      // impl params: [T]
 *     fn map<U>(&self) -> U { .. } // method params: [T, U]
 * }
 * ```
 *
 * The bounds become **predicates** like `T: Clone`. Inside the body these are
 * *assumptions* (the param environment); at call sites they are *obligations*
 * the caller must prove.
 */
import type { Diagnostics, Span } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { Def, DefId, PartialRes } from "../resolve/defs.ts";
import type { ResolveResults } from "../resolve/resolver.ts";
import { ERROR, NEVER, UNIT, showTy, substitute, type Subst, type Ty } from "./types.ts";

export interface TraitRef {
  trait: DefId;
  args: Ty[];
}

export type Predicate =
  | { kind: "trait"; self: Ty; trait: DefId; args: Ty[] }
  /** `<self as trait>::name == ty`, from bounds like `I: Iterator<Item = u8>`. */
  | { kind: "proj"; self: Ty; trait: DefId; traitArgs: Ty[]; name: string; ty: Ty };

export interface FnSig {
  /** Parameter types, with the `self` parameter first for methods. */
  params: Ty[];
  ret: Ty;
  selfKind?: A.SelfParamKind;
  /** True if the method takes `self` in any form. */
  hasSelf: boolean;
}

export interface FieldInfo {
  name: string;
  ty: Ty;
  isPub: boolean;
  span: Span;
}

export interface VariantInfo {
  def: DefId;
  name: string;
  fieldsKind: A.FieldsKind;
  fields: FieldInfo[];
}

export interface ImplHeader {
  selfTy: Ty;
  trait?: TraitRef;
}

export interface TraitInfo {
  /** The synthetic type parameter standing for `Self` inside the trait. */
  selfParam: DefId;
  methods: Map<string, DefId>;
  assocTypes: Map<string, DefId>;
  supertraits: TraitRef[];
}

/** Context for converting a type expression: what `Self` means, and how to make fresh inference variables. */
export interface AstConvCtx {
  selfTy?: Ty;
  /** Inside function bodies, `_` and omitted generic args become inference variables. */
  fresh?: () => Ty;
}

export class TyCtxt {
  readonly defs: Def[];
  readonly res: ResolveResults;
  readonly diags: Diagnostics;

  private readonly sigCache = new Map<DefId, FnSig>();
  private readonly paramsCache = new Map<DefId, DefId[]>();
  private readonly predCache = new Map<DefId, Predicate[]>();
  private readonly headerCache = new Map<DefId, ImplHeader | undefined>();
  private readonly traitCache = new Map<DefId, TraitInfo>();
  private readonly variantCache = new Map<DefId, VariantInfo[]>();
  private readonly typeOfCache = new Map<DefId, Ty>();
  private readonly aliasInProgress = new Set<DefId>();

  /** Inherent impls by the "head" of their self type: an ADT DefId or a primitive name. */
  readonly inherentImpls = new Map<string, DefId[]>();
  /** Trait impls by trait. */
  readonly traitImpls = new Map<DefId, DefId[]>();
  /** ADT DefId → derived trait DefIds. */
  readonly derives = new Map<DefId, Set<DefId>>();

  constructor(res: ResolveResults, diags: Diagnostics) {
    this.res = res;
    this.defs = res.defs;
    this.diags = diags;
    for (const impl of res.impls) {
      const header = this.implHeader(impl);
      if (!header) continue;
      if (header.trait) {
        const list = this.traitImpls.get(header.trait.trait) ?? [];
        list.push(impl);
        this.traitImpls.set(header.trait.trait, list);
      } else {
        const key = headKey(header.selfTy);
        if (key === undefined) {
          this.diags.error("typeck", this.defs[impl].span, `inherent impls are only allowed for structs and enums defined in this program`, "E0118");
          continue;
        }
        const list = this.inherentImpls.get(key) ?? [];
        list.push(impl);
        this.inherentImpls.set(key, list);
      }
    }
    for (const def of this.defs) {
      if ((def.kind === "struct" || def.kind === "enum") && def.node) {
        const node = def.node as A.StructItem | A.EnumItem;
        const set = new Set<DefId>();
        for (const name of node.derives) {
          const t = res.lang.get(name);
          if (t !== undefined) set.add(t);
        }
        if (set.size) this.derives.set(def.id, set);
      }
    }
  }

  lang(name: string): DefId {
    const d = this.res.lang.get(name);
    if (d === undefined) throw new Error(`missing lang item ${name}`);
    return d;
  }

  langAdt(name: string, args: Ty[] = []): Ty {
    return { k: "adt", def: this.lang(name), args };
  }

  nameOf = (def: DefId): string => this.defs[def]?.name ?? `#${def}`;

  show(t: Ty): string {
    return showTy(t, this.nameOf);
  }

  /** `crate::module::Item` style path for a def, used in diagnostics and bytecode symbol names. */
  pathOf(def: DefId): string {
    const d = this.defs[def];
    if (d.parent === undefined) return d.name;
    const p = this.defs[d.parent];
    if (p.kind === "impl") {
      const h = this.implHeader(d.parent);
      const head = h ? (h.trait ? `<${this.show(h.selfTy)} as ${this.nameOf(h.trait.trait)}>` : this.show(h.selfTy)) : "<impl>";
      return `${head}::${d.name}`;
    }
    if (p.name === "{block}") return this.pathOf(d.parent);
    return `${this.pathOf(d.parent)}::${d.name}`;
  }

  // -------------------------------------------------------------------------
  // Generics
  // -------------------------------------------------------------------------

  /** The owner of a def's generics, walking out from methods to their impl/trait. */
  genericParent(def: DefId): DefId | undefined {
    const d = this.defs[def];
    if ((d.kind === "fn" || d.kind === "typeAlias" || d.kind === "const" || d.kind === "assocTy") && d.parent !== undefined) {
      const p = this.defs[d.parent];
      if (p.kind === "impl" || p.kind === "trait") return d.parent;
    }
    if (d.kind === "variant") return d.parent;
    return undefined;
  }

  /** All generic params in scope for `def`: parent's first, then its own. Traits start with `Self`. */
  allParams(def: DefId): DefId[] {
    const cached = this.paramsCache.get(def);
    if (cached) return cached;
    const parent = this.genericParent(def);
    const own = this.defs[def].kind === "variant" ? [] : (this.res.genericsOf.get(def) ?? []);
    let params = [...(parent !== undefined ? this.allParams(parent) : []), ...own];
    if (this.defs[def].kind === "trait") params = [this.traitInfo(def).selfParam, ...params];
    this.paramsCache.set(def, params);
    return params;
  }

  paramTy(p: DefId): Ty {
    return { k: "param", def: p, name: this.defs[p].name };
  }

  identitySubst(def: DefId): Subst {
    return new Map(this.allParams(def).map((p) => [p, this.paramTy(p)]));
  }

  /** What `Self` means inside an item. */
  selfTyOf(owner: DefId): Ty | undefined {
    const d = this.defs[owner];
    if (d.kind === "impl") return this.implHeader(owner)?.selfTy;
    if (d.kind === "trait") return this.paramTy(this.traitInfo(owner).selfParam);
    if (d.kind === "struct" || d.kind === "enum") return { k: "adt", def: owner, args: (this.res.genericsOf.get(owner) ?? []).map((p) => this.paramTy(p)) };
    const parent = this.genericParent(owner);
    return parent !== undefined ? this.selfTyOf(parent) : undefined;
  }

  /** The where-clauses in scope for `def` (including parents' and, for trait items, `Self: Trait`). */
  predicates(def: DefId): Predicate[] {
    const cached = this.predCache.get(def);
    if (cached) return cached;
    this.predCache.set(def, []); // guard against cycles
    const d = this.defs[def];
    const parent = this.genericParent(def);
    const preds: Predicate[] = parent !== undefined ? [...this.predicates(parent)] : [];
    const ctx: AstConvCtx = { selfTy: this.selfTyOf(def) };
    if (d.kind === "trait") {
      const info = this.traitInfo(def);
      const params = this.allParams(def);
      preds.push({ kind: "trait", self: this.paramTy(info.selfParam), trait: def, args: params.slice(1).map((p) => this.paramTy(p)) });
    }
    if (d.kind !== "variant") {
      for (const p of this.res.genericsOf.get(def) ?? []) {
        for (const bound of this.defs[p].bounds ?? []) preds.push(...this.boundToPredicates(this.paramTy(p), bound, ctx));
      }
    }
    this.predCache.set(def, preds);
    return preds;
  }

  /** `T: Iterator<Item = u8>` → `[T: Iterator, <T as Iterator>::Item == u8]` */
  boundToPredicates(self: Ty, bound: A.Path, ctx: AstConvCtx): Predicate[] {
    const tr = this.traitRefFromPath(bound, self, ctx);
    if (!tr) return [];
    const preds: Predicate[] = [{ kind: "trait", self, trait: tr.trait, args: tr.args }];
    for (const b of bound.segments[bound.segments.length - 1].bindings ?? []) {
      preds.push({ kind: "proj", self, trait: tr.trait, traitArgs: tr.args, name: b.name, ty: this.astToTy(b.ty, ctx) });
    }
    return preds;
  }

  /** Resolve a trait path with its generic args; missing args take their defaults (`Rhs = Self`). */
  traitRefFromPath(path: A.Path, self: Ty, ctx: AstConvCtx): TraitRef | undefined {
    const pr = this.res.paths.get(path.id);
    if (!pr || pr.base.kind !== "def" || this.defs[pr.base.def].kind !== "trait") return undefined;
    const trait = pr.base.def;
    const written = (path.segments[path.segments.length - 1].generics ?? []).map((g) => this.astToTy(g, ctx));
    const params = this.res.genericsOf.get(trait) ?? [];
    const node = this.defs[trait].node as A.TraitItem;
    const args: Ty[] = [];
    params.forEach((p, i) => {
      if (i < written.length) args.push(written[i]);
      else {
        const def = node.generics.params[i].default;
        args.push(def ? this.astToTy(def, { ...ctx, selfTy: self }) : (ctx.fresh?.() ?? ERROR));
      }
    });
    if (written.length > params.length) {
      this.diags.error("typeck", path.span, `trait takes ${params.length} generic argument(s) but ${written.length} were supplied`, "E0107");
    }
    return { trait, args };
  }

  // -------------------------------------------------------------------------
  // AST type → Ty
  // -------------------------------------------------------------------------

  astToTy(t: A.TypeExpr, ctx: AstConvCtx): Ty {
    switch (t.kind) {
      case "ref": return { k: "ref", mutable: t.mutable, inner: this.astToTy(t.inner, ctx) };
      case "tuple": return t.elems.length === 0 ? UNIT : { k: "tuple", elems: t.elems.map((e) => this.astToTy(e, ctx)) };
      case "never": return NEVER;
      case "infer":
        if (ctx.fresh) return ctx.fresh();
        this.diags.error("typeck", t.span, "the placeholder `_` is not allowed within types on item signatures", "E0121");
        return ERROR;
      case "qpath": {
        const self = this.astToTy(t.self, ctx);
        const tr = this.traitRefFromPath(t.trait, self, ctx);
        if (!tr) return ERROR;
        return { k: "proj", trait: tr.trait, traitArgs: tr.args, self, name: t.name };
      }
      case "path": {
        const pr = this.res.paths.get(t.path.id);
        if (!pr) return ERROR;
        return this.pathToTy(t.path, pr, ctx);
      }
    }
  }

  /** Convert generic args written on a path segment, filling in missing ones. */
  genericArgs(seg: A.PathSegment, params: DefId[], ctx: AstConvCtx, owner: DefId, span: Span): Ty[] {
    const written = (seg.generics ?? []).map((g) => this.astToTy(g, ctx));
    if (written.length === 0 && params.length > 0) {
      if (ctx.fresh) return params.map(() => ctx.fresh!());
      this.diags.error("typeck", span, `missing generics for \`${this.defs[owner].name}\``, "E0107")
        .help(`add the generic argument(s): \`${this.defs[owner].name}<${params.map((p) => this.defs[p].name).join(", ")}>\``);
      return params.map(() => ERROR);
    }
    if (written.length !== params.length) {
      this.diags.error("typeck", span, `\`${this.defs[owner].name}\` takes ${params.length} generic argument(s) but ${written.length} were supplied`, "E0107");
      return params.map((_, i) => written[i] ?? ERROR);
    }
    return written;
  }

  private pathToTy(path: A.Path, pr: PartialRes, ctx: AstConvCtx): Ty {
    const baseSeg = path.segments[Math.max(0, pr.baseIndex)];
    let base: Ty;
    const r = pr.base;
    if (r.kind === "prim") {
      base = primTy(r.name);
    } else if (r.kind === "selfTy") {
      base = ctx.selfTy ?? this.selfTyOf(r.owner) ?? ERROR;
    } else if (r.kind === "def") {
      const d = this.defs[r.def];
      switch (d.kind) {
        case "struct": case "enum":
          base = { k: "adt", def: d.id, args: this.genericArgs(baseSeg, this.res.genericsOf.get(d.id) ?? [], ctx, d.id, path.span) };
          break;
        case "tyParam":
          base = this.paramTy(d.id);
          break;
        case "typeAlias": {
          if (this.aliasInProgress.has(d.id)) {
            this.diags.error("typeck", path.span, `cycle detected when expanding type alias \`${d.name}\``, "E0391");
            return ERROR;
          }
          const node = d.node as A.TypeAliasItem;
          const params = this.res.genericsOf.get(d.id) ?? [];
          const args = this.genericArgs(baseSeg, params, ctx, d.id, path.span);
          this.aliasInProgress.add(d.id);
          const aliased = node.ty ? this.astToTy(node.ty, { selfTy: ctx.selfTy }) : ERROR;
          this.aliasInProgress.delete(d.id);
          base = substitute(aliased, new Map(params.map((p, i) => [p, args[i]])));
          break;
        }
        case "variant":
          this.diags.error("typeck", path.span, `expected type, found variant \`${d.name}\``, "E0573")
            .help(`use the enum type \`${this.defs[d.parent!].name}\` instead`);
          return ERROR;
        default:
          this.diags.error("typeck", path.span, `expected type, found ${d.kind} \`${d.name}\``, "E0573");
          return ERROR;
      }
    } else {
      return ERROR;
    }
    // `T::Item` / `Self::Item`: an associated type through a bound.
    if (pr.unresolved.length > 0) {
      const name = pr.unresolved[0].name;
      if (pr.unresolved.length > 1) {
        this.diags.error("typeck", path.span, `ambiguous associated type path`, "E0223");
        return ERROR;
      }
      return this.assocTypeOf(base, name, path.span, ctx);
    }
    return base;
  }

  /** Find the trait that provides associated type `name` for `self` (through bounds in scope). */
  private assocTypeOf(self: Ty, name: string, span: Span, ctx: AstConvCtx): Ty {
    // Inside an impl of a trait, `Self::Item` is simply the impl's own definition.
    const candidates: TraitRef[] = [];
    if (self.k === "param") {
      const owner = this.defs[self.def].parent;
      const preds = owner !== undefined ? this.predicatesForParamLookup(self.def) : [];
      for (const p of preds) {
        if (p.kind === "trait" && p.self.k === "param" && p.self.def === self.def) {
          for (const tr of this.elaborate({ trait: p.trait, args: p.args })) {
            if (this.traitInfo(tr.trait).assocTypes.has(name)) candidates.push(tr);
          }
        }
      }
    } else if (ctx.selfTy) {
      // `Self::Item` inside `impl Iterator for Foo`: search impls whose self type is this type.
      for (const [trait, impls] of this.traitImpls) {
        if (!this.traitInfo(trait).assocTypes.has(name)) continue;
        for (const impl of impls) {
          const h = this.implHeader(impl);
          if (h?.trait && h.selfTy === ctx.selfTy) candidates.push(h.trait);
        }
      }
    }
    if (candidates.length === 0) {
      this.diags.error("typeck", span, `associated type \`${name}\` not found for \`${this.show(self)}\``, "E0220");
      return ERROR;
    }
    const tr = candidates[0];
    return { k: "proj", trait: tr.trait, traitArgs: tr.args, self, name };
  }

  /** Predicates of the item that owns generic param `p` (plus trait `Self` bounds). */
  private predicatesForParamLookup(p: DefId): Predicate[] {
    const d = this.defs[p];
    if (d.name === "Self" && d.parent !== undefined && this.defs[d.parent].kind === "trait") {
      const trait = d.parent;
      return [{ kind: "trait", self: this.paramTy(p), trait, args: this.allParams(trait).slice(1).map((x) => this.paramTy(x)) }];
    }
    // Bounds on a generic param are recorded on the param itself, which avoids recursion through `predicates`.
    const out: Predicate[] = [];
    for (const bound of d.bounds ?? []) {
      const pr = this.res.paths.get(bound.id);
      if (pr?.base.kind === "def" && this.defs[pr.base.def].kind === "trait") {
        out.push({ kind: "trait", self: this.paramTy(p), trait: pr.base.def, args: [] });
      }
    }
    // Also `where` clauses folded into this param's bounds by the parser — already included above.
    return out;
  }

  /** A trait plus all its supertraits, transitively. */
  elaborate(tr: TraitRef): TraitRef[] {
    const out: TraitRef[] = [];
    const seen = new Set<DefId>();
    const go = (t: TraitRef) => {
      if (seen.has(t.trait)) return;
      seen.add(t.trait);
      out.push(t);
      for (const s of this.traitInfo(t.trait).supertraits) go(s);
    };
    go(tr);
    return out;
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  traitInfo(trait: DefId): TraitInfo {
    const cached = this.traitCache.get(trait);
    if (cached) return cached;
    const d = this.defs[trait];
    const node = d.node as A.TraitItem;
    // Synthesize a `Self` type parameter for the trait.
    const selfParam = this.defs.length;
    this.defs.push({ id: selfParam, kind: "tyParam", name: "Self", crate: d.crate, parent: trait, module: d.module, isPub: false, span: d.span, paramIndex: -1, bounds: [] });
    const info: TraitInfo = { selfParam, methods: new Map(), assocTypes: new Map(), supertraits: [] };
    this.traitCache.set(trait, info);
    for (const fn of node.items) info.methods.set(fn.name, this.res.defOfNode.get(fn.id)!);
    for (const ty of node.assocTypes) info.assocTypes.set(ty.name, this.res.defOfNode.get(ty.id)!);
    const selfTy = this.paramTy(selfParam);
    for (const s of node.supertraits) {
      const tr = this.traitRefFromPath(s, selfTy, { selfTy });
      if (tr) info.supertraits.push(tr);
    }
    return info;
  }

  implHeader(impl: DefId): ImplHeader | undefined {
    if (this.headerCache.has(impl)) return this.headerCache.get(impl);
    this.headerCache.set(impl, undefined);
    const node = this.defs[impl].node as A.ImplItem;
    const selfTy = this.astToTy(node.selfTy, {});
    const header: ImplHeader = { selfTy };
    this.headerCache.set(impl, header);
    if (node.traitPath) header.trait = this.traitRefFromPath(node.traitPath, selfTy, { selfTy });
    return header;
  }

  /** The type of an impl's associated type `name`, in terms of the impl's generic params. */
  implAssocType(impl: DefId, name: string): Ty | undefined {
    const node = this.defs[impl].node as A.ImplItem;
    const item = node.assocTypes.find((t) => t.name === name);
    if (!item?.ty) return undefined;
    return this.astToTy(item.ty, { selfTy: this.implHeader(impl)?.selfTy });
  }

  /** Find a method/const named `name` directly inside an impl. */
  implItem(impl: DefId, name: string): DefId | undefined {
    const node = this.defs[impl].node as A.ImplItem;
    const fn = node.items.find((f) => f.name === name);
    if (fn) return this.res.defOfNode.get(fn.id);
    const c = node.consts.find((f) => f.name === name);
    return c ? this.res.defOfNode.get(c.id) : undefined;
  }

  fnSig(def: DefId): FnSig {
    const cached = this.sigCache.get(def);
    if (cached) return cached;
    const fn = this.defs[def].node as A.FnItem;
    const selfTy = this.selfTyOf(def);
    const ctx: AstConvCtx = { selfTy };
    const params: Ty[] = [];
    if (fn.selfParam) {
      const s = selfTy ?? ERROR;
      params.push(fn.selfParam.kind === "value" ? s : { k: "ref", mutable: fn.selfParam.kind === "refMut", inner: s });
    }
    for (const p of fn.params) params.push(this.astToTy(p.ty, ctx));
    const sig: FnSig = { params, ret: fn.ret ? this.astToTy(fn.ret, ctx) : UNIT, selfKind: fn.selfParam?.kind, hasSelf: !!fn.selfParam };
    this.sigCache.set(def, sig);
    return sig;
  }

  /** The declared type of a `const` item. */
  constTy(def: DefId): Ty {
    const cached = this.typeOfCache.get(def);
    if (cached) return cached;
    const node = this.defs[def].node as A.ConstItem;
    const t = this.astToTy(node.ty, { selfTy: this.selfTyOf(def) });
    this.typeOfCache.set(def, t);
    return t;
  }

  /** Variants of an enum, or the single "variant" of a struct. Field types use the ADT's own params. */
  variants(adt: DefId): VariantInfo[] {
    const cached = this.variantCache.get(adt);
    if (cached) return cached;
    const d = this.defs[adt];
    const selfTy = this.selfTyOf(adt);
    const ctx: AstConvCtx = { selfTy };
    const conv = (fields: A.FieldDef[]): FieldInfo[] => fields.map((f) => ({ name: f.name, ty: this.astToTy(f.ty, ctx), isPub: f.isPub, span: f.span }));
    let out: VariantInfo[];
    this.variantCache.set(adt, []);
    if (d.kind === "struct") {
      const node = d.node as A.StructItem;
      out = [{ def: adt, name: node.name, fieldsKind: node.fieldsKind, fields: conv(node.fields) }];
    } else {
      const node = d.node as A.EnumItem;
      out = node.variants.map((v) => {
        const scope = d.scope!;
        const b = scope.types.get(v.name)!;
        return { def: (b.res as { def: DefId }).def, name: v.name, fieldsKind: v.fieldsKind, fields: conv(v.fields) };
      });
    }
    this.variantCache.set(adt, out);
    return out;
  }

  /** Is this ADT one of the natively-implemented std types (Vec, String, Box, HashMap, Formatter)? */
  isNativeAdt(def: DefId): boolean {
    return ["Vec", "String", "Box", "HashMap", "Formatter"].some((n) => this.res.lang.get(n) === def);
  }

  isLang(def: DefId, name: string): boolean {
    return this.res.lang.get(name) === def;
  }
}

/** The key used to index inherent impls: an ADT's DefId, or a primitive's name. */
export function headKey(t: Ty): string | undefined {
  switch (t.k) {
    case "adt": return `adt${t.def}`;
    case "int": case "float": return t.name;
    case "bool": case "char": case "str": return t.k;
    default: return undefined;
  }
}

export function primTy(name: string): Ty {
  switch (name) {
    case "bool": return { k: "bool" };
    case "char": return { k: "char" };
    case "str": return { k: "str" };
    case "f32": case "f64": return { k: "float", name };
    default: return { k: "int", name: name as Extract<Ty, { k: "int" }>["name"] };
  }
}
