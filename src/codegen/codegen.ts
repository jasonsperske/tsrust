/**
 * # Stage 7: Code generation
 *
 * The code generator turns typed AST into stack-machine bytecode.
 *
 * ## Monomorphization
 *
 * Generic functions are compiled **once per set of concrete type
 * arguments**, just like rustc does:
 *
 * ```mermaid
 * flowchart LR
 *   main --> L1["largest::&lt;i32&gt;"]
 *   main --> L2["largest::&lt;char&gt;"]
 *   L1 --> G1["&lt;i32 as PartialOrd&gt;::gt<br/>(native GT)"]
 *   L2 --> G2["&lt;char as PartialOrd&gt;::gt<br/>(native GT)"]
 * ```
 *
 * We start from `main` and keep a work queue of *instances* (a function plus
 * concrete types for its generic params). Compiling one instance discovers the
 * calls it makes, which enqueues more instances. Functions that are never
 * called are never compiled.
 *
 * ## Static dispatch of trait methods
 *
 * The type checker records calls to trait methods abstractly
 * (`<T as Display>::fmt`). Once `T` is known, we **select** the impl and call
 * its method directly (or the trait's default method, or a built-in
 * operation for primitives and `#[derive]`d impls). There are no vtables.
 *
 * ## Memory model
 *
 * Each local variable gets a numbered slot in its function's frame. Structs,
 * tuples and enums are heap objects; *moving* one just copies the pointer
 * (the borrow checker guarantees the old owner is never used again), while
 * *copying* a `Copy` aggregate makes a real copy so the two can't alias.
 */
import type { Diagnostics, SourceMap, Span } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { DefId } from "../resolve/defs.ts";
import { InferCtxt } from "../typeck/infer.ts";
import type { TypeckOutput } from "../typeck/index.ts";
import type { Callee, TypeckResults } from "../typeck/results.ts";
import type { TyCtxt } from "../typeck/tcx.ts";
import { TraitSolver } from "../typeck/traits.ts";
import { ERROR, UNIT, substitute, tyKey, type Subst, type Ty } from "../typeck/types.ts";
import { NUM_KINDS, Op, OPS } from "../bytecode/opcodes.ts";
import type { FunctionCode, Program, SourceLoc, TypeDesc } from "../bytecode/program.ts";

/** How a resolved call is implemented. */
type Target =
  | { kind: "fn"; def: DefId; substs: Ty[] }
  /** `substs` are the callee's generic args (HashMap intrinsics pass the key type on to the runtime). */
  | { kind: "intrinsic"; name: string; substs?: Ty[] }
  | { kind: "builtin"; trait: string; method: string; self: Ty };

interface Instance {
  index: number;
  def: DefId;
  subst: Subst;
}

export function generate(tc: TypeckOutput, sources: SourceMap, diags: Diagnostics): Program | undefined {
  const main = tc.tcx.res.main;
  if (main === undefined) {
    return undefined;
  }
  const g = new ProgramBuilder(tc, sources, diags);
  const entry = g.instance(main, []);
  g.drain();
  return { constants: g.constants, types: g.types, intrinsics: g.intrinsics, locs: g.locs, functions: g.functions, entry };
}

class ProgramBuilder {
  readonly constants: (number | string)[] = [];
  private readonly constIndex = new Map<string, number>();
  readonly types: TypeDesc[] = [];
  private readonly typeIndex = new Map<string, number>();
  readonly intrinsics: string[] = [];
  private readonly intrinsicIndex = new Map<string, number>();
  readonly locs: SourceLoc[] = [];
  private readonly locIndex = new Map<string, number>();
  readonly functions: FunctionCode[] = [];
  private readonly instances = new Map<string, number>();
  private readonly queue: Instance[] = [];
  readonly tcx: TyCtxt;
  readonly r: TypeckResults;
  readonly infcx = new InferCtxt();
  readonly solver: TraitSolver;
  private readonly copyCache = new Map<string, boolean>();
  readonly sources: SourceMap;
  readonly diags: Diagnostics;

  constructor(tc: TypeckOutput, sources: SourceMap, diags: Diagnostics) {
    this.tcx = tc.tcx;
    this.r = tc.results;
    this.sources = sources;
    this.diags = diags;
    this.solver = new TraitSolver(this.tcx, this.infcx, []);
  }

  constant(v: number | string): number {
    const key = typeof v === "number" ? `n${Object.is(v, -0) ? "-0" : v}` : `s${v}`;
    let i = this.constIndex.get(key);
    if (i === undefined) {
      i = this.constants.length;
      this.constants.push(v);
      this.constIndex.set(key, i);
    }
    return i;
  }

  intrinsic(name: string): number {
    let i = this.intrinsicIndex.get(name);
    if (i === undefined) {
      i = this.intrinsics.length;
      this.intrinsics.push(name);
      this.intrinsicIndex.set(name, i);
    }
    return i;
  }

  loc(span: Span): number {
    const file = this.sources.get(span.file);
    if (!file) return -1;
    const pos = file.position(span.start);
    const key = `${file.name}:${pos.line}:${pos.col}`;
    let i = this.locIndex.get(key);
    if (i === undefined) {
      i = this.locs.length;
      this.locs.push({ file: file.name.replace(/^\//, ""), line: pos.line, col: pos.col });
      this.locIndex.set(key, i);
    }
    return i;
  }

  /** Normalize associated types in a fully concrete type. */
  normalize(t: Ty): Ty {
    return this.infcx.resolve(this.solver.normalizeDeep(t, () => undefined));
  }

  isCopy(t: Ty): boolean {
    const key = tyKey(t);
    let v = this.copyCache.get(key);
    if (v === undefined) {
      v = this.solver.holds(t, this.tcx.lang("Copy"));
      this.copyCache.set(key, v);
    }
    return v;
  }

  /** Is this a heap aggregate that must be duplicated when copied? */
  needsCopy(t: Ty): boolean {
    if (t.k === "tuple") return t.elems.length > 0 && this.isCopy(t);
    if (t.k === "adt") return !this.tcx.isNativeAdt(t.def) && this.isCopy(t);
    return false;
  }

  /** Intern a runtime type descriptor. */
  typeDesc(t: Ty): number {
    const key = tyKey(t);
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const index = this.types.length;
    this.types.push({ k: "opaque", name: "?" });
    this.typeIndex.set(key, index);
    this.types[index] = this.buildDesc(t);
    return index;
  }

  private buildDesc(t: Ty): TypeDesc {
    switch (t.k) {
      case "int": return { k: "int", name: t.name };
      case "float": return { k: "float", name: t.name };
      case "bool": return { k: "bool" };
      case "char": return { k: "char" };
      case "str": return { k: "str" };
      case "never": return { k: "never" };
      case "tuple": return t.elems.length === 0 ? { k: "unit" } : { k: "tuple", elems: t.elems.map((e) => this.typeDesc(e)) };
      case "ref": return { k: "ref", inner: this.typeDesc(t.inner) };
      case "adt": {
        const lang = (n: string) => this.tcx.isLang(t.def, n);
        if (lang("Vec")) return { k: "vec", elem: this.typeDesc(t.args[0]) };
        if (lang("String") || lang("Formatter")) return { k: "string" };
        if (lang("Box")) return { k: "box", inner: this.typeDesc(t.args[0]) };
        if (lang("HashMap")) return { k: "map", key: this.typeDesc(t.args[0]), value: this.typeDesc(t.args[1]) };
        const subst = new Map((this.tcx.res.genericsOf.get(t.def) ?? []).map((p, i) => [p, t.args[i]]));
        const conv = (fields: { name: string; ty: Ty }[]) => fields.map((f) => ({ name: f.name, ty: this.typeDesc(this.normalize(substitute(f.ty, subst))) }));
        const variants = this.tcx.variants(t.def);
        const name = this.tcx.nameOf(t.def);
        if (this.tcx.defs[t.def].kind === "struct") return { k: "struct", name, kind: variants[0].fieldsKind, fields: conv(variants[0].fields) };
        return { k: "enum", name, variants: variants.map((v) => ({ name: v.name, kind: v.fieldsKind, fields: conv(v.fields) })) };
      }
      default: return { k: "opaque", name: t.k };
    }
  }

  numKind(t: Ty): number {
    const isStr = t.k === "str" || (t.k === "ref" && t.inner.k === "str");
    const name = t.k === "int" || t.k === "float" ? t.name : t.k === "bool" ? "bool" : t.k === "char" ? "char" : isStr ? "str" : "i32";
    return (NUM_KINDS as readonly string[]).indexOf(name);
  }

  /** Get (or create) the function index for `def` instantiated with `substs`. */
  instance(def: DefId, substs: Ty[]): number {
    const key = `${def}<${substs.map(tyKey).join(",")}>`;
    const existing = this.instances.get(key);
    if (existing !== undefined) return existing;
    const index = this.functions.length;
    const params = this.tcx.allParams(def);
    const subst: Subst = new Map(params.map((p, i) => [p, substs[i] ?? ERROR]));
    const label = this.tcx.pathOf(def) + (substs.length ? `::<${substs.map((s) => this.tcx.show(s)).join(", ")}>` : "");
    this.functions.push({ name: label, params: 0, locals: 0, code: [], lines: [] });
    this.instances.set(key, index);
    this.queue.push({ index, def, subst });
    return index;
  }

  drain() {
    while (this.queue.length) {
      const inst = this.queue.shift()!;
      const fn = this.tcx.defs[inst.def].node as A.FnItem;
      const fc = new FnCompiler(this, inst.subst);
      this.functions[inst.index] = { ...fc.compileFn(fn, inst.def), name: this.functions[inst.index].name };
    }
  }

  /** The name the VM uses for an intrinsic: `Vec::push`, `str::len`, `mem::replace`, `i32::pow`... */
  intrinsicName(def: DefId): string {
    const d = this.tcx.defs[def];
    const parent = d.parent !== undefined ? this.tcx.defs[d.parent] : undefined;
    if (parent?.kind === "impl") {
      const self = this.tcx.implHeader(parent.id)!.selfTy;
      const head = self.k === "adt" ? this.tcx.nameOf(self.def) : self.k === "int" || self.k === "float" ? self.name : self.k;
      return `${head}::${d.name}`;
    }
    return `${this.tcx.defs[d.module].name}::${d.name}`;
  }

  /** Decide what a (monomorphized) callee actually runs. */
  resolveCallee(def: DefId, substs: Ty[]): Target {
    const d = this.tcx.defs[def];
    const parent = d.parent !== undefined ? this.tcx.defs[d.parent] : undefined;
    if (parent?.kind === "trait") {
      const trait = parent.id;
      const traitParams = this.tcx.allParams(trait);
      const self = substs[0];
      const traitArgs = substs.slice(1, traitParams.length);
      const methodArgs = substs.slice(traitParams.length);
      const snap = this.infcx.snapshot();
      const sel = this.solver.select(self, trait, traitArgs);
      const traitName = this.solver.traitName(trait) ?? this.tcx.nameOf(trait);
      if (sel.kind === "impl") {
        const implMethod = this.tcx.implItem(sel.impl, d.name);
        const implSubsts = this.tcx.allParams(sel.impl).map((p) => this.infcx.resolve(sel.subst.get(p) ?? ERROR));
        this.infcx.rollback(snap);
        if (implMethod !== undefined) {
          if (this.tcx.defs[implMethod].intrinsic) {
            if (traitName === "Debug" || traitName === "Display") return { kind: "builtin", trait: traitName, method: d.name, self };
            return { kind: "intrinsic", name: this.intrinsicName(implMethod), substs: implSubsts };
          }
          return { kind: "fn", def: implMethod, substs: [...implSubsts, ...methodArgs] };
        }
        return { kind: "fn", def, substs }; // trait default method
      }
      this.infcx.rollback(snap);
      if (sel.kind === "builtin" || sel.kind === "derived") {
        // Default methods with bodies (like `Ord::max`) still run as Rust code.
        const fn = d.node as A.FnItem;
        const nativeMethods = ["clone", "eq", "ne", "partial_cmp", "cmp", "lt", "le", "gt", "ge", "fmt", "default"];
        if (fn.body && !nativeMethods.includes(d.name)) return { kind: "fn", def, substs };
        return { kind: "builtin", trait: traitName, method: d.name, self };
      }
      throw new Error(`codegen: no impl of ${this.tcx.nameOf(trait)} for ${this.tcx.show(self)}`);
    }
    if (d.intrinsic) return { kind: "intrinsic", name: this.intrinsicName(def), substs };
    return { kind: "fn", def, substs };
  }
}

interface LoopCtx {
  continueTarget: number;
  breaks: number[];
  depth: number;
  resultSlot?: number;
}

/** A place as the code generator sees it: a root slot plus projections. */
interface CgPlace {
  slot: number;
  proj: ({ k: "field"; i: number } | { k: "deref"; via: "ref" | "box" | "str" | "none" } | { k: "index"; slot: number; map: boolean; keyTy?: Ty })[];
  ty: Ty;
}

class FnCompiler {
  private code: number[] = [];
  private lines: number[] = [];
  private slots = 0;
  private readonly slotOf = new Map<A.NodeId, number>();
  private readonly loops = new Map<A.NodeId, LoopCtx>();
  /** Static operand-stack depth, used to clean up when `break` leaves expressions mid-evaluation. */
  private depth = 0;
  private lastLoc = -1;
  private readonly g: ProgramBuilder;
  private readonly subst: Subst;
  private readonly tcx: TyCtxt;
  private readonly r: TypeckResults;

  constructor(g: ProgramBuilder, subst: Subst) {
    this.g = g;
    this.subst = subst;
    this.tcx = g.tcx;
    this.r = g.r;
  }

  // -------------------------------------------------------------------------
  // Emission helpers
  // -------------------------------------------------------------------------

  private emit(op: number, ...operands: number[]) {
    this.code.push(op, ...operands);
    this.depth += stackEffect(op, operands);
  }

  private here(): number {
    return this.code.length;
  }

  /** Emit a jump with a placeholder target; returns the operand position to patch. */
  private jump(op: number): number {
    this.emit(op, -1);
    return this.code.length - 1;
  }

  private patch(pos: number, target = this.here()) {
    this.code[pos] = target;
  }

  private newSlot(): number {
    return this.slots++;
  }

  private setLoc(span: Span) {
    const loc = this.g.loc(span);
    if (loc < 0 || loc === this.lastLoc) return;
    this.lastLoc = loc;
    this.lines.push(this.here(), loc);
  }

  private ty(id: A.NodeId): Ty {
    return this.mono(this.r.types.get(id) ?? ERROR);
  }

  private mono(t: Ty): Ty {
    return this.g.normalize(substitute(t, this.subst));
  }

  private emitConst(v: number | string) {
    this.emit(Op.CONST, this.g.constant(v));
  }

  // -------------------------------------------------------------------------
  // Functions
  // -------------------------------------------------------------------------

  compileFn(fn: A.FnItem, def: DefId): FunctionCode {
    let params = 0;
    if (fn.selfParam) { this.slotOf.set(fn.selfParam.id, this.newSlot()); params++; }
    const complex: { pat: A.Pattern; slot: number }[] = [];
    for (const p of fn.params) {
      const slot = this.newSlot();
      params++;
      if (p.pat.kind === "ident" && !this.tcx.res.patternPaths.has(p.pat.id)) this.slotOf.set(p.pat.id, slot);
      else complex.push({ pat: p.pat, slot });
    }
    for (const c of complex) this.bindPattern(c.pat, { slot: c.slot, proj: [], ty: this.ty(c.pat.id) });
    if (!fn.body) throw new Error(`codegen: ${this.tcx.pathOf(def)} has no body`);
    this.setLoc(fn.body.span);
    this.expr(fn.body);
    this.emit(Op.RET);
    return { name: "", params, locals: this.slots, code: this.code, lines: this.lines };
  }

  // -------------------------------------------------------------------------
  // Places
  // -------------------------------------------------------------------------

  private isPlaceExpr(e: A.Expr): boolean {
    if (e.kind === "path") {
      const pr = this.tcx.res.paths.get(e.path.id);
      return pr?.base.kind === "local" && pr.unresolved.length === 0;
    }
    return e.kind === "field" || e.kind === "index" || (e.kind === "unary" && e.op === "*");
  }

  private derefTy(t: Ty): Ty {
    if (t.k === "ref") return t.inner;
    if (t.k === "adt" && (this.tcx.isLang(t.def, "Box"))) return t.args[0];
    if (t.k === "adt" && this.tcx.isLang(t.def, "String")) return { k: "str" };
    return ERROR;
  }

  /** How to dereference a value of type `t`. `&str` is the string itself, so its deref is a no-op. */
  private derefVia(t: Ty): "ref" | "box" | "str" | "none" {
    if (t.k === "ref") return t.inner.k === "str" ? "none" : "ref";
    if (t.k === "adt" && this.tcx.isLang(t.def, "Box")) return "box";
    return "str";
  }

  /** Apply the recorded auto-derefs of expression `e` to a place. */
  private adjust(p: CgPlace, e: A.Expr): CgPlace {
    const adj = this.r.adjustments.get(e.id);
    if (!adj) return p;
    let { ty } = p;
    const proj = [...p.proj];
    for (const _ of adj.derefs) {
      proj.push({ k: "deref", via: this.derefVia(ty) });
      ty = this.derefTy(ty);
    }
    return { slot: p.slot, proj, ty };
  }

  /** Compute the place of `e`, evaluating sub-expressions (like indices) into temporaries. */
  private place(e: A.Expr): CgPlace {
    switch (e.kind) {
      case "path": {
        const pr = this.tcx.res.paths.get(e.path.id);
        if (pr?.base.kind === "local") {
          const slot = this.slotOf.get(pr.base.id);
          if (slot !== undefined) return { slot, proj: [], ty: this.ty(e.id) };
        }
        break;
      }
      case "field": {
        const base = this.adjust(this.place(e.expr), e.expr);
        return { slot: base.slot, proj: [...base.proj, { k: "field", i: this.r.fieldIndices.get(e.id) ?? 0 }], ty: this.ty(e.id) };
      }
      case "index": {
        const base = this.adjust(this.place(e.expr), e.expr);
        if (this.r.strSlices.has(e.id) && e.index.kind === "range") {
          // Compute the substring now; a `str` place is just its string value.
          const range = e.index;
          const slot = this.newSlot();
          this.loadPlace(base);
          if (range.start) this.expr(range.start); else this.emitConst(0);
          if (range.end) {
            this.expr(range.end);
            if (range.inclusive) { this.emitConst(1); this.emit(Op.ADD, this.g.numKind({ k: "int", name: "usize" })); }
          } else {
            this.loadPlace(base);
            this.emit(Op.INTRINSIC, this.g.intrinsic("str::len"), 1);
          }
          this.setLoc(e.span);
          this.emit(Op.INTRINSIC, this.g.intrinsic("str::slice"), 3);
          this.emit(Op.STORE, slot);
          return { slot, proj: [], ty: { k: "str" } };
        }
        const idx = this.newSlot();
        this.expr(e.index);
        this.emit(Op.STORE, idx);
        const isMap = base.ty.k === "adt" && this.tcx.isLang(base.ty.def, "HashMap");
        const keyTy = isMap && base.ty.k === "adt" ? base.ty.args[0] : undefined;
        return { slot: base.slot, proj: [...base.proj, { k: "index", slot: idx, map: isMap, keyTy }], ty: this.ty(e.id) };
      }
      case "unary": {
        if (e.op !== "*") break;
        const inner = this.adjust(this.place(e.expr), e.expr);
        return { slot: inner.slot, proj: [...inner.proj, { k: "deref", via: this.derefVia(inner.ty) }], ty: this.ty(e.id) };
      }
    }
    // Not a place: evaluate into a fresh temporary.
    const slot = this.newSlot();
    this.expr(e);
    this.emit(Op.STORE, slot);
    return { slot, proj: [], ty: this.ty(e.id) };
  }

  /** Push the value stored at a place (no copy). */
  private loadPlace(p: CgPlace) {
    if (p.proj.some((x) => x.k === "index" && x.map)) {
      this.refPlace(p);
      this.emit(Op.LOAD_REF);
      return;
    }
    this.emit(Op.LOAD, p.slot);
    for (const pr of p.proj) {
      if (pr.k === "field") this.emit(Op.GET_FIELD, pr.i);
      else if (pr.k === "deref") { if (pr.via !== "none") this.emit(pr.via === "box" ? Op.GET_BOX : pr.via === "str" ? Op.STR_OF : Op.LOAD_REF); }
      else { this.emit(Op.LOAD, pr.slot); this.emit(Op.INDEX_GET); }
    }
  }

  /** Push a reference to a place. */
  private refPlace(p: CgPlace) {
    // `&str` is represented by the string itself.
    if (p.ty.k === "str") {
      this.loadPlace(p);
      return;
    }
    this.emit(Op.REF_LOCAL, p.slot);
    for (const pr of p.proj) {
      if (pr.k === "field") this.emit(Op.FIELD_REF, pr.i);
      else if (pr.k === "deref") { if (pr.via !== "none") this.emit(pr.via === "str" ? Op.STR_REF : Op.DEREF_REF); }
      else if (pr.map) {
        this.emit(Op.LOAD_REF);
        this.emit(Op.LOAD, pr.slot);
        this.emitConst(this.g.typeDesc(pr.keyTy ?? ERROR));
        this.emit(Op.INTRINSIC, this.g.intrinsic("HashMap::index_ref"), 3);
      } else {
        this.emit(Op.LOAD, pr.slot);
        this.emit(Op.INDEX_REF);
      }
    }
  }

  /** Store the value produced by `value()` into a place. */
  private storePlace(p: CgPlace, value: () => void) {
    if (p.proj.length === 0) {
      value();
      this.emit(Op.STORE, p.slot);
      return;
    }
    this.refPlace(p);
    value();
    this.emit(Op.STORE_REF);
  }

  /** Push a copy-or-move of the value at a place. */
  private readPlace(p: CgPlace) {
    this.loadPlace(p);
    if (this.g.needsCopy(p.ty)) this.emit(Op.COPY, this.g.typeDesc(p.ty));
  }

  /** Push a reference to `e`'s place, or to a temporary holding its value. */
  private refOf(e: A.Expr) {
    if (this.isPlaceExpr(e)) {
      this.refPlace(this.adjust(this.place(e), e));
    } else {
      const slot = this.newSlot();
      this.expr(e);
      this.emit(Op.STORE, slot);
      this.emit(Op.REF_LOCAL, slot);
    }
  }

  // -------------------------------------------------------------------------
  // Expressions: each pushes exactly one value
  // -------------------------------------------------------------------------

  expr(e: A.Expr): void {
    const start = this.depth;
    this.exprInner(e);
    // Diverging expressions may leave the bookkeeping unbalanced; normalize it.
    this.depth = start + 1;
    const coerce = this.r.coercions.get(e.id);
    if (coerce) for (const step of coerce) this.emit(step === "ref" ? Op.LOAD_REF : step === "box" ? Op.DEREF_REF : Op.STR_REF);
  }

  private exprInner(e: A.Expr): void {
    switch (e.kind) {
      case "lit": return this.lit(e.value);
      case "path": return this.pathExpr(e);
      case "unary": return this.unary(e);
      case "ref": {
        if (this.isPlaceExpr(e.expr)) this.refPlace(this.adjust(this.place(e.expr), e.expr));
        else {
          const t = this.ty(e.expr.id);
          this.expr(e.expr);
          if (t.k === "str") return; // `&*"literal"`: a str is already its own reference
          const slot = this.newSlot();
          this.emit(Op.STORE, slot);
          this.emit(Op.REF_LOCAL, slot);
        }
        return;
      }
      case "binary": return this.binary(e);
      case "assign": return this.assign(e);
      case "call": return this.call(e);
      case "methodCall": return this.methodCall(e);
      case "field": case "index":
        this.setLoc(e.span);
        this.readPlace(this.adjust(this.place(e), e));
        return;
      case "structLit": return this.structLit(e);
      case "tuple":
        if (e.elems.length === 0) { this.emit(Op.UNIT); return; }
        for (const x of e.elems) this.expr(x);
        this.emit(Op.MAKE_AGG, 0, e.elems.length);
        return;
      case "block": return this.block(e);
      case "if": {
        this.expr(e.cond);
        const toElse = this.jump(Op.JUMP_IF_FALSE);
        const base = this.depth;
        this.expr(e.then);
        const toEnd = this.jump(Op.JUMP);
        this.patch(toElse);
        this.depth = base;
        if (e.else) this.expr(e.else);
        else this.emit(Op.UNIT);
        this.patch(toEnd);
        return;
      }
      case "while": {
        const top = this.here();
        const loop: LoopCtx = { continueTarget: top, breaks: [], depth: this.depth };
        this.loops.set(e.id, loop);
        this.expr(e.cond);
        const exit = this.jump(Op.JUMP_IF_FALSE);
        this.expr(e.body);
        this.emit(Op.POP);
        this.emit(Op.JUMP, top);
        this.patch(exit);
        for (const b of loop.breaks) this.patch(b);
        this.emit(Op.UNIT);
        return;
      }
      case "loop": {
        const resultSlot = this.newSlot();
        const top = this.here();
        const loop: LoopCtx = { continueTarget: top, breaks: [], depth: this.depth, resultSlot };
        this.loops.set(e.id, loop);
        this.expr(e.body);
        this.emit(Op.POP);
        this.emit(Op.JUMP, top);
        for (const b of loop.breaks) this.patch(b);
        this.emit(Op.LOAD, resultSlot);
        return;
      }
      case "for": return this.forLoop(e);
      case "break": {
        const loop = this.loops.get(this.tcx.res.labels.get(e.id) ?? -1)!;
        if (e.value) this.expr(e.value);
        else this.emit(Op.UNIT);
        if (loop.resultSlot !== undefined) this.emit(Op.STORE, loop.resultSlot);
        else this.emit(Op.POP);
        for (let d = this.depth; d > loop.depth; d--) this.emit(Op.POP);
        loop.breaks.push(this.jump(Op.JUMP));
        return;
      }
      case "continue": {
        const loop = this.loops.get(this.tcx.res.labels.get(e.id) ?? -1)!;
        for (let d = this.depth; d > loop.depth; d--) this.emit(Op.POP);
        this.emit(Op.JUMP, loop.continueTarget);
        return;
      }
      case "return":
        if (e.value) this.expr(e.value);
        else this.emit(Op.UNIT);
        this.emit(Op.RET);
        return;
      case "match": return this.match(e);
      case "range":
        this.expr(e.start!);
        this.expr(e.end!);
        if (e.inclusive) { this.emit(Op.FALSE); this.emit(Op.MAKE_AGG, 0, 3); }
        else this.emit(Op.MAKE_AGG, 0, 2);
        return;
      case "cast": {
        const from = this.ty(e.expr.id), to = this.ty(e.id);
        this.expr(e.expr);
        if (from.k === "adt") {
          this.emit(Op.GET_TAG);
          this.emit(Op.CAST, this.g.numKind({ k: "int", name: "i32" }), this.g.numKind(to));
        } else if (from.k !== to.k || this.g.numKind(from) !== this.g.numKind(to)) {
          this.emit(Op.CAST, this.g.numKind(from), this.g.numKind(to));
        }
        return;
      }
      case "try": {
        const slot = this.newSlot();
        this.expr(e.expr);
        this.emit(Op.STORE, slot);
        this.emit(Op.LOAD, slot);
        this.emit(Op.GET_TAG);
        const isOption = this.r.tryKinds.get(e.id) === "option";
        // Option: Some = 1 continues. Result: Ok = 0 continues.
        const ok = this.jump(isOption ? Op.JUMP_IF_TRUE : Op.JUMP_IF_FALSE);
        // The early-return value has the same runtime shape (`None` / `Err(e)`).
        this.emit(Op.LOAD, slot);
        this.emit(Op.RET);
        this.patch(ok);
        this.depth--;
        this.emit(Op.LOAD, slot);
        this.emit(Op.GET_FIELD, 0);
        return;
      }
      case "macro": return this.macro(e);
    }
  }

  private lit(l: A.Literal) {
    switch (l.kind) {
      case "int": this.emitConst(l.value); return;
      case "float": this.emit(Op.CONST_F, this.g.constant(l.value)); return;
      case "bool": this.emit(l.value ? Op.TRUE : Op.FALSE); return;
      case "char": this.emit(Op.CONST_CHAR, this.g.constant(l.value)); return;
      case "str": this.emitConst(l.value); return;
    }
  }

  private pathExpr(e: Extract<A.Expr, { kind: "path" }>) {
    if (this.isPlaceExpr(e)) {
      this.readPlace(this.adjust(this.place(e), e));
      return;
    }
    const ctor = this.r.ctors.get(e.id);
    if (ctor) {
      const d = this.tcx.defs[ctor.def];
      this.emit(Op.MAKE_AGG, d.kind === "variant" ? d.variantIndex! : 0, 0);
      return;
    }
    const callee = this.r.callees.get(e.id);
    if (callee && this.tcx.defs[callee.def].kind === "const") {
      this.constValue(callee);
      return;
    }
    throw new Error(`codegen: unsupported path expression ${e.path.segments.map((s) => s.name).join("::")}`);
  }

  private constValue(callee: Callee) {
    const node = this.tcx.defs[callee.def].node as A.ConstItem;
    this.expr(node.value);
  }

  private unary(e: Extract<A.Expr, { kind: "unary" }>) {
    if (e.op === "*") {
      this.readPlace(this.adjust(this.place(e), e));
      return;
    }
    const callee = this.r.callees.get(e.id);
    if (callee) {
      this.expr(e.expr);
      this.callTarget(this.resolve(callee), 1, e.span);
      return;
    }
    this.expr(e.expr);
    this.applyNumericDeref(e.expr);
    const t = this.ty(e.id);
    this.emit(e.op === "-" ? Op.NEG : Op.NOT, this.g.numKind(t));
  }

  /** `&a + b`: the type checker recorded an auto-deref of a numeric operand. */
  private applyNumericDeref(e: A.Expr) {
    // Place expressions already had their adjustments applied by `adjust()`.
    if (this.isPlaceExpr(e)) return;
    const adj = this.r.adjustments.get(e.id);
    if (adj && !adj.autoref) for (const _ of adj.derefs) this.emit(Op.LOAD_REF);
  }

  private resolve(callee: Callee): Target {
    return this.g.resolveCallee(callee.def, callee.substs.map((t) => this.mono(t)));
  }

  private binary(e: Extract<A.Expr, { kind: "binary" }>) {
    const op = e.op;
    if (op === "&&" || op === "||") {
      this.expr(e.left);
      this.emit(Op.DUP);
      const short = this.jump(op === "&&" ? Op.JUMP_IF_FALSE : Op.JUMP_IF_TRUE);
      this.emit(Op.POP);
      this.expr(e.right);
      this.patch(short);
      return;
    }
    this.setLoc(e.span);
    const callee = this.r.callees.get(e.id);
    const isCmp = ["==", "!=", "<", "<=", ">", ">="].includes(op);
    if (isCmp && callee) {
      const target = this.resolve(callee);
      if (target.kind === "builtin") {
        this.expr(e.left);
        this.expr(e.right);
        const td = this.g.typeDesc(target.self);
        if (op === "==" || op === "!=") {
          this.emit(Op.DEEP_EQ, td);
          if (op === "!=") this.emit(Op.NOT, this.g.numKind({ k: "bool" }));
        } else {
          this.emit(Op.DEEP_CMP, td);
          this.emitConst(0);
          this.emit(({ "<": Op.LT, "<=": Op.LE, ">": Op.GT, ">=": Op.GE } as Record<string, number>)[op], this.g.numKind({ k: "int", name: "i32" }));
        }
        return;
      }
      this.refOf(e.left);
      this.refOf(e.right);
      this.callTarget(target, 2, e.span);
      return;
    }
    if (callee) {
      // Overloaded arithmetic: `Add::add(a, b)`.
      this.expr(e.left);
      this.expr(e.right);
      this.callTarget(this.resolve(callee), 2, e.span);
      return;
    }
    this.expr(e.left);
    this.applyNumericDeref(e.left);
    this.expr(e.right);
    this.applyNumericDeref(e.right);
    const k = this.g.numKind(this.ty(e.left.id).k === "ref" ? (this.ty(e.left.id) as { inner: Ty }).inner : this.ty(e.left.id));
    const table: Record<string, number> = {
      "+": Op.ADD, "-": Op.SUB, "*": Op.MUL, "/": Op.DIV, "%": Op.REM, "&": Op.BITAND, "|": Op.BITOR, "^": Op.BITXOR, "<<": Op.SHL, ">>": Op.SHR,
      "==": Op.EQ, "!=": Op.NE, "<": Op.LT, "<=": Op.LE, ">": Op.GT, ">=": Op.GE,
    };
    this.emit(table[op], k);
  }

  private assign(e: Extract<A.Expr, { kind: "assign" }>) {
    this.setLoc(e.span);
    const callee = this.r.callees.get(e.id);
    if (e.op === "=") {
      const p = this.place(e.target);
      this.storePlace(p, () => this.expr(e.value));
      this.emit(Op.UNIT);
      return;
    }
    const p = this.place(e.target);
    if (callee) {
      this.refPlace(p);
      this.expr(e.value);
      this.callTarget(this.resolve(callee), 2, e.span);
      return; // returns ()
    }
    const opTable: Record<string, number> = { "+=": Op.ADD, "-=": Op.SUB, "*=": Op.MUL, "/=": Op.DIV, "%=": Op.REM, "&=": Op.BITAND, "|=": Op.BITOR, "^=": Op.BITXOR, "<<=": Op.SHL, ">>=": Op.SHR };
    const k = this.g.numKind(p.ty);
    if (p.proj.length === 0) {
      this.emit(Op.LOAD, p.slot);
      this.expr(e.value);
      this.applyNumericDeref(e.value);
      this.emit(opTable[e.op], k);
      this.emit(Op.STORE, p.slot);
    } else {
      this.refPlace(p);
      this.emit(Op.DUP);
      this.emit(Op.LOAD_REF);
      this.expr(e.value);
      this.applyNumericDeref(e.value);
      this.emit(opTable[e.op], k);
      this.emit(Op.STORE_REF);
    }
    this.emit(Op.UNIT);
  }

  private call(e: Extract<A.Expr, { kind: "call" }>) {
    const ctor = this.r.ctors.get(e.id);
    for (const a of e.args) this.expr(a);
    this.setLoc(e.span);
    if (ctor) {
      const d = this.tcx.defs[ctor.def];
      this.emit(Op.MAKE_AGG, d.kind === "variant" ? d.variantIndex! : 0, e.args.length);
      return;
    }
    const callee = this.r.callees.get(e.id)!;
    this.callTarget(this.resolve(callee), e.args.length, e.span);
  }

  private methodCall(e: Extract<A.Expr, { kind: "methodCall" }>) {
    const adj = this.r.adjustments.get(e.receiver.id);
    const base = this.isPlaceExpr(e.receiver) ? this.place(e.receiver) : this.tempPlace(e.receiver);
    const p = this.adjust(base, e.receiver);
    if (adj?.autoref) this.refPlace(p);
    else this.readPlace(p);
    for (const a of e.args) this.expr(a);
    // Panics inside the method are reported at the method name, like rustc's #[track_caller].
    this.setLoc(e.methodSpan);
    this.callTarget(this.resolve(this.r.callees.get(e.id)!), e.args.length + 1, e.methodSpan);
  }

  private tempPlace(e: A.Expr): CgPlace {
    const slot = this.newSlot();
    this.expr(e);
    this.emit(Op.STORE, slot);
    return { slot, proj: [], ty: this.ty(e.id) };
  }

  /** Emit the call for a resolved target. Arguments are already on the stack. */
  private callTarget(t: Target, argc: number, span: Span) {
    this.setLoc(span);
    if (t.kind === "fn") {
      this.emit(Op.CALL, this.g.instance(t.def, t.substs), argc);
      return;
    }
    if (t.kind === "intrinsic") {
      // Native code can't inspect values at runtime, so map operations get the
      // key's type descriptor (for hashing and equality) as a trailing argument.
      if (/^(HashMap|collections)::/.test(t.name) && t.substs?.length) {
        this.emitConst(this.g.typeDesc(t.substs[0]));
        argc++;
      }
      this.emit(Op.INTRINSIC, this.g.intrinsic(t.name), argc);
      return;
    }
    this.builtinMethod(t, argc);
  }

  /** Trait methods implemented natively: for primitives and `#[derive]`d impls. */
  private builtinMethod(t: Extract<Target, { kind: "builtin" }>, argc: number) {
    const td = this.g.typeDesc(t.self);
    switch (t.method) {
      case "clone":
        this.emit(Op.LOAD_REF);
        this.emit(Op.CLONE, td);
        return;
      case "eq": case "ne":
        this.derefTwo();
        this.emit(Op.DEEP_EQ, td);
        if (t.method === "ne") this.emit(Op.NOT, this.g.numKind({ k: "bool" }));
        return;
      case "lt": case "le": case "gt": case "ge":
        this.derefTwo();
        this.emit(Op.DEEP_CMP, td);
        this.emitConst(0);
        this.emit(({ lt: Op.LT, le: Op.LE, gt: Op.GT, ge: Op.GE } as Record<string, number>)[t.method], this.g.numKind({ k: "int", name: "i32" }));
        return;
      case "partial_cmp": case "cmp":
        this.derefTwo();
        this.emit(Op.DEEP_CMP, td);
        this.emit(Op.INTRINSIC, this.g.intrinsic(t.method === "cmp" ? "cmp::to_ordering" : "cmp::to_option_ordering"), 1);
        return;
      case "fmt": {
        // Stack: [&self, &mut Formatter] → append to the formatter, return Ok(()).
        const f = this.newSlot();
        this.emit(Op.STORE, f);
        this.emit(Op.LOAD_REF);
        const v = this.newSlot();
        this.emit(Op.STORE, v);
        this.emit(Op.LOAD, f);
        this.emit(Op.LOAD_REF);
        this.emit(Op.LOAD, v);
        this.emit(Op.FMT, td, t.trait === "Debug" ? 1 : 0, -1);
        this.emit(Op.UNIT);
        this.emit(Op.MAKE_AGG, 0, 1);
        return;
      }
      case "default":
        this.emit(Op.DEFAULT, td);
        return;
    }
    throw new Error(`codegen: no built-in implementation of ${t.trait}::${t.method} (argc ${argc})`);
  }

  /** Stack `[&a, &b]` → `[a, b]`. */
  private derefTwo() {
    const b = this.newSlot();
    this.emit(Op.STORE, b);
    this.emit(Op.LOAD_REF);
    this.emit(Op.LOAD, b);
    this.emit(Op.LOAD_REF);
  }

  private structLit(e: Extract<A.Expr, { kind: "structLit" }>) {
    const ctor = this.r.ctors.get(e.id)!;
    const d = this.tcx.defs[ctor.def];
    const adt = d.kind === "variant" ? d.parent! : d.id;
    const variant = this.tcx.variants(adt).find((v) => v.def === ctor.def)!;
    // Evaluate field initializers in source order, then assemble in declaration order.
    const slots = new Map<number, number>();
    for (const f of e.fields) {
      const slot = this.newSlot();
      this.expr(f.value);
      this.emit(Op.STORE, slot);
      slots.set(this.r.fieldIndices.get(f.value.id)!, slot);
    }
    let baseSlot: number | undefined;
    if (e.base) {
      baseSlot = this.newSlot();
      this.expr(e.base);
      this.emit(Op.STORE, baseSlot);
    }
    variant.fields.forEach((_, i) => {
      const s = slots.get(i);
      if (s !== undefined) this.emit(Op.LOAD, s);
      else { this.emit(Op.LOAD, baseSlot!); this.emit(Op.GET_FIELD, i); }
    });
    this.emit(Op.MAKE_AGG, d.kind === "variant" ? d.variantIndex! : 0, variant.fields.length);
  }

  private block(b: A.BlockExpr) {
    for (const s of b.stmts) {
      if (s.kind === "let") {
        this.setLoc(s.span);
        if (!s.init) {
          this.declarePattern(s.pat);
          continue;
        }
        this.expr(s.init);
        const slot = this.newSlot();
        this.emit(Op.STORE, slot);
        this.bindPattern(s.pat, { slot, proj: [], ty: this.ty(s.init.id) });
      } else if (s.kind === "expr") {
        this.setLoc(s.span);
        this.expr(s.expr);
        this.emit(Op.POP);
      }
    }
    if (b.tail) this.expr(b.tail);
    else this.emit(Op.UNIT);
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  /** Allocate slots for the bindings of a pattern without assigning them. */
  private declarePattern(p: A.Pattern) {
    switch (p.kind) {
      case "ident":
        if (!this.tcx.res.patternPaths.has(p.id) && !this.slotOf.has(p.id)) this.slotOf.set(p.id, this.newSlot());
        if (p.sub) this.declarePattern(p.sub);
        return;
      case "tuple": case "tupleStruct": p.elems.forEach((x) => this.declarePattern(x)); return;
      case "struct": p.fields.forEach((f) => this.declarePattern(f.pat)); return;
      case "ref": this.declarePattern(p.inner); return;
      case "or": {
        // All alternatives bind the same names; share one slot per name.
        const last = p.alts[p.alts.length - 1];
        this.declarePattern(last);
        const names = new Map<string, number>();
        collectIdents(last, (id, name) => { const s = this.slotOf.get(id); if (s !== undefined) names.set(name, s); });
        for (const alt of p.alts.slice(0, -1)) collectIdents(alt, (id, name) => { const s = names.get(name); if (s !== undefined) this.slotOf.set(id, s); });
        return;
      }
    }
  }

  /** Bind an irrefutable pattern (let, params, for). */
  private bindPattern(p: A.Pattern, place: CgPlace) {
    this.declarePattern(p);
    this.testPattern(p, place, undefined);
  }

  /**
   * Emit code that checks whether the value at `place` matches `p`, binding
   * variables as it goes. On mismatch, jumps are recorded in `fails` (or, for
   * irrefutable contexts where `fails` is undefined, no test is emitted).
   */
  private testPattern(p: A.Pattern, place: CgPlace, fails: number[] | undefined) {
    const derefs = this.r.patDerefs.get(p.id) ?? 0;
    for (let i = 0; i < derefs; i++) {
      place = { slot: place.slot, proj: [...place.proj, { k: "deref", via: this.derefVia(place.ty) }], ty: this.derefTy(place.ty) };
    }
    const ty = this.ty(p.id);
    place = { ...place, ty };
    const fail = (op: number) => { const j = this.jump(op); if (fails) fails.push(j); };
    switch (p.kind) {
      case "wild": return;
      case "ident": {
        const asPath = this.tcx.res.patternPaths.get(p.id);
        if (asPath) { this.testCtorOrConst(p, place, fails); return; }
        const slot = this.slotOf.get(p.id)!;
        const mode = this.r.bindingModes.get(p.id) ?? "move";
        if (mode === "move") this.readPlace(place);
        else this.refPlace(place);
        this.emit(Op.STORE, slot);
        if (p.sub) this.testPattern(p.sub, place, fails);
        return;
      }
      case "lit": {
        if (!fails) return;
        this.loadPlace(place);
        this.lit(p.value);
        this.emit(Op.EQ, this.g.numKind(ty));
        fail(Op.JUMP_IF_FALSE);
        return;
      }
      case "range": {
        if (!fails) return;
        this.loadPlace(place);
        this.lit(p.lo);
        this.emit(Op.GE, this.g.numKind(ty));
        fail(Op.JUMP_IF_FALSE);
        this.loadPlace(place);
        this.lit(p.hi);
        this.emit(p.inclusive ? Op.LE : Op.LT, this.g.numKind(ty));
        fail(Op.JUMP_IF_FALSE);
        return;
      }
      case "tuple": {
        const elems = ty.k === "tuple" ? ty.elems : [];
        p.elems.forEach((x, i) => this.testPattern(x, { slot: place.slot, proj: [...place.proj, { k: "field", i }], ty: elems[i] ?? ERROR }, fails));
        return;
      }
      case "ref":
        this.testPattern(p.inner, { slot: place.slot, proj: [...place.proj, { k: "deref", via: this.derefVia(ty) }], ty: this.derefTy(ty) }, fails);
        return;
      case "path": this.testCtorOrConst(p, place, fails); return;
      case "tupleStruct": case "struct": {
        const ctor = this.r.ctors.get(p.id)!;
        const d = this.tcx.defs[ctor.def];
        if (d.kind === "variant" && fails) {
          this.loadPlace(place);
          this.emit(Op.GET_TAG);
          this.emitConst(d.variantIndex!);
          this.emit(Op.EQ, this.g.numKind({ k: "int", name: "i32" }));
          fail(Op.JUMP_IF_FALSE);
        }
        const fieldTys = this.fieldTys(ty, ctor.def);
        const subs = p.kind === "tupleStruct" ? p.elems.map((x, i) => ({ x, i })) : p.fields.map((f) => ({ x: f.pat, i: this.r.fieldIndices.get(f.pat.id) ?? 0 }));
        for (const { x, i } of subs) this.testPattern(x, { slot: place.slot, proj: [...place.proj, { k: "field", i }], ty: fieldTys[i] ?? ERROR }, fails);
        return;
      }
      case "or": {
        if (!fails) { this.testPattern(p.alts[0], place, undefined); return; }
        const success: number[] = [];
        p.alts.forEach((alt, i) => {
          const altFails: number[] = [];
          this.testPattern(alt, place, altFails);
          success.push(this.jump(Op.JUMP));
          for (const f of altFails) this.patch(f);
          if (i === p.alts.length - 1) fail(Op.JUMP);
        });
        for (const s of success) this.patch(s);
        return;
      }
    }
  }

  private fieldTys(ty: Ty, ctorDef: DefId): Ty[] {
    if (ty.k !== "adt") return [];
    const v = this.tcx.variants(ty.def).find((x) => x.def === ctorDef);
    if (!v) return [];
    const subst = new Map((this.tcx.res.genericsOf.get(ty.def) ?? []).map((g, i) => [g, ty.args[i]]));
    return v.fields.map((f) => this.g.normalize(substitute(f.ty, subst)));
  }

  private testCtorOrConst(p: A.Pattern, place: CgPlace, fails: number[] | undefined) {
    if (!fails) return;
    const ctor = this.r.ctors.get(p.id);
    this.loadPlace(place);
    if (ctor) {
      const d = this.tcx.defs[ctor.def];
      if (d.kind !== "variant") { this.emit(Op.POP); return; } // unit struct: always matches
      this.emit(Op.GET_TAG);
      this.emitConst(d.variantIndex!);
      this.emit(Op.EQ, this.g.numKind({ k: "int", name: "i32" }));
    } else {
      const callee = this.r.callees.get(p.id);
      if (callee) this.constValue(callee);
      this.emit(Op.DEEP_EQ, this.g.typeDesc(place.ty));
    }
    const j = this.jump(Op.JUMP_IF_FALSE);
    fails.push(j);
  }

  private match(e: Extract<A.Expr, { kind: "match" }>) {
    this.setLoc(e.span);
    const scrutTy = this.ty(e.scrutinee.id);
    let place: CgPlace;
    if (this.isPlaceExpr(e.scrutinee)) {
      // Matching a place: bindings by reference must point into it.
      const p = this.adjust(this.place(e.scrutinee), e.scrutinee);
      const refSlot = this.newSlot();
      this.refPlace(p);
      this.emit(Op.STORE, refSlot);
      place = { slot: refSlot, proj: [{ k: "deref", via: "ref" }], ty: scrutTy };
    } else {
      const slot = this.newSlot();
      this.expr(e.scrutinee);
      this.emit(Op.STORE, slot);
      place = { slot, proj: [], ty: scrutTy };
    }
    const base = this.depth;
    const ends: number[] = [];
    for (const arm of e.arms) {
      this.depth = base;
      const fails: number[] = [];
      this.declarePattern(arm.pat);
      this.testPattern(arm.pat, place, fails);
      if (arm.guard) {
        this.expr(arm.guard);
        fails.push(this.jump(Op.JUMP_IF_FALSE));
      }
      this.expr(arm.body);
      ends.push(this.jump(Op.JUMP));
      for (const f of fails) this.patch(f);
    }
    this.depth = base;
    this.emit(Op.UNREACHABLE);
    for (const j of ends) this.patch(j);
    this.depth = base + 1;
  }

  private forLoop(e: Extract<A.Expr, { kind: "for" }>) {
    const info = this.r.forLoops.get(e.id)!;
    this.setLoc(e.iter.span);
    this.expr(e.iter);
    this.callTarget(this.resolve(info.intoIter), 1, e.iter.span);
    const iterSlot = this.newSlot();
    this.emit(Op.STORE, iterSlot);
    const nextSlot = this.newSlot();
    const top = this.here();
    const loop: LoopCtx = { continueTarget: top, breaks: [], depth: this.depth };
    this.loops.set(e.id, loop);
    this.emit(Op.REF_LOCAL, iterSlot);
    this.callTarget(this.resolve(info.next), 1, e.iter.span);
    this.emit(Op.STORE, nextSlot);
    this.emit(Op.LOAD, nextSlot);
    this.emit(Op.GET_TAG);
    const exit = this.jump(Op.JUMP_IF_FALSE); // None = 0
    const itemTy = this.mono(info.itemTy);
    this.bindPattern(e.pat, { slot: nextSlot, proj: [{ k: "field", i: 0 }], ty: itemTy });
    this.expr(e.body);
    this.emit(Op.POP);
    this.emit(Op.JUMP, top);
    this.patch(exit);
    for (const b of loop.breaks) this.patch(b);
    this.emit(Op.UNIT);
  }

  // -------------------------------------------------------------------------
  // Macros and formatting
  // -------------------------------------------------------------------------

  private macro(e: Extract<A.Expr, { kind: "macro" }>) {
    this.setLoc(e.span);
    switch (e.name) {
      case "println": case "print": case "eprintln": case "eprint": {
        const target = this.newString();
        this.format(e.format, { slot: target, isRef: false });
        this.emit(Op.LOAD, target);
        const newline = e.name.endsWith("ln") ? 1 : 0;
        const stderr = e.name.startsWith("e") ? 2 : 0;
        this.emit(Op.PRINT, newline | stderr);
        this.emit(Op.UNIT);
        return;
      }
      case "format": {
        const target = this.newString();
        this.format(e.format, { slot: target, isRef: false });
        this.emit(Op.LOAD, target);
        return;
      }
      case "write": case "writeln": {
        const slot = this.newSlot();
        this.expr(e.args[0]);
        this.emit(Op.STORE, slot);
        this.format(e.format, { slot, isRef: true });
        if (e.name === "writeln") { this.emit(Op.LOAD, slot); this.emit(Op.LOAD_REF); this.emitConst("\n"); this.emit(Op.STR_APPEND); }
        this.emit(Op.UNIT);
        this.emit(Op.MAKE_AGG, 0, 1); // Ok(())
        return;
      }
      case "panic": case "unreachable": case "todo": case "unimplemented": {
        const defaults: Record<string, string> = { panic: "explicit panic", unreachable: "internal error: entered unreachable code", todo: "not yet implemented", unimplemented: "not implemented" };
        if (e.format) {
          const target = this.newString();
          if (e.name === "unreachable") this.appendText(target, "internal error: entered unreachable code: ");
          this.format(e.format, { slot: target, isRef: false });
          this.emit(Op.LOAD, target);
        } else {
          this.emitConst(defaults[e.name]);
        }
        this.emit(Op.PANIC);
        return;
      }
      case "vec": {
        if (e.repeat) {
          this.expr(e.args[0]);
          this.expr(e.args[1]);
          this.emitConst(this.g.typeDesc(this.ty(e.args[0].id)));
          this.emit(Op.INTRINSIC, this.g.intrinsic("vec::from_elem"), 3);
        } else {
          for (const a of e.args) this.expr(a);
          this.emit(Op.INTRINSIC, this.g.intrinsic("vec::from_elems"), e.args.length);
        }
        return;
      }
      case "assert": {
        this.expr(e.args[0]);
        const ok = this.jump(Op.JUMP_IF_TRUE);
        if (e.format) {
          const t = this.newString();
          this.format(e.format, { slot: t, isRef: false });
          this.emit(Op.LOAD, t);
        } else {
          this.emitConst(`assertion failed: ${this.g.sources.snippet(e.args[0].span)}`);
        }
        this.emit(Op.PANIC);
        this.patch(ok);
        this.depth--;
        this.emit(Op.UNIT);
        return;
      }
      case "assert_eq": case "assert_ne": {
        const ty = this.ty(e.args[0].id);
        const a = this.newSlot(), b = this.newSlot();
        this.expr(e.args[0]); this.emit(Op.STORE, a);
        this.expr(e.args[1]); this.emit(Op.STORE, b);
        this.emitEquality(ty, a, b);
        const ok = this.jump(e.name === "assert_eq" ? Op.JUMP_IF_TRUE : Op.JUMP_IF_FALSE);
        const msg = this.newString();
        this.appendText(msg, `assertion \`left ${e.name === "assert_eq" ? "==" : "!="} right\` failed`);
        if (e.format) {
          this.appendText(msg, ": ");
          this.format(e.format, { slot: msg, isRef: false });
        }
        this.appendText(msg, "\n  left: ");
        this.appendFmt(msg, a, ty, 1);
        this.appendText(msg, "\n right: ");
        this.appendFmt(msg, b, ty, 1);
        this.emit(Op.LOAD, msg);
        this.emit(Op.PANIC);
        this.patch(ok);
        this.depth--;
        this.emit(Op.UNIT);
        return;
      }
    }
    throw new Error(`codegen: unsupported macro ${e.name}!`);
  }

  /** Push `a == b` for values stored in slots, dispatching on PartialEq. */
  private emitEquality(ty: Ty, a: number, b: number) {
    const eqTrait = this.tcx.lang("PartialEq");
    const eqMethod = this.tcx.traitInfo(eqTrait).methods.get("eq")!;
    const target = this.g.resolveCallee(eqMethod, [ty]);
    if (target.kind === "builtin") {
      this.emit(Op.LOAD, a);
      this.emit(Op.LOAD, b);
      this.emit(Op.DEEP_EQ, this.g.typeDesc(ty));
    } else {
      this.emit(Op.REF_LOCAL, a);
      this.emit(Op.REF_LOCAL, b);
      this.callTarget(target, 2, this.g.sources.files[0] ? { file: 0, start: 0, end: 0 } : { file: -1, start: 0, end: 0 });
    }
  }

  private newString(): number {
    const slot = this.newSlot();
    this.emit(Op.NEW_STRING);
    this.emit(Op.STORE, slot);
    return slot;
  }

  private appendText(slot: number, text: string, isRef = false) {
    this.emit(Op.LOAD, slot);
    if (isRef) this.emit(Op.LOAD_REF);
    this.emitConst(text);
    this.emit(Op.STR_APPEND);
  }

  /** Append the formatted value in `valueSlot` (of type `ty`) to the string in `target`. */
  private appendFmt(target: number, valueSlot: number, ty: Ty, flags: number, precision = -1, targetIsRef = false) {
    // Peel references: `&T: Display` forwards to `T`.
    let base = ty;
    let refs = 0;
    while (base.k === "ref") { base = base.inner; refs++; }
    const traitName = flags & 1 ? "Debug" : "Display";
    const trait = this.tcx.lang(traitName);
    const method = this.tcx.traitInfo(trait).methods.get("fmt")!;
    const t = this.g.resolveCallee(method, [base]);
    if (t.kind !== "fn") {
      this.emit(Op.LOAD, targetIsRef ? valueSlot : valueSlot);
      // FMT expects [String, value].
      const v = this.newSlot();
      this.emit(Op.STORE, v);
      this.emit(Op.LOAD, target);
      if (targetIsRef) this.emit(Op.LOAD_REF);
      this.emit(Op.LOAD, v);
      this.emit(Op.FMT, this.g.typeDesc(ty), flags, precision);
      return;
    }
    // A user `impl Display`: call `fmt(&value, &mut formatter)`.
    if (refs === 0) this.emit(Op.REF_LOCAL, valueSlot);
    else {
      this.emit(Op.LOAD, valueSlot);
      for (let i = 1; i < refs; i++) this.emit(Op.LOAD_REF);
    }
    if (targetIsRef) this.emit(Op.LOAD, target);
    else this.emit(Op.REF_LOCAL, target);
    this.emit(Op.CALL, this.g.instance(t.def, t.substs), 2);
    this.emit(Op.POP);
  }

  private format(spec: A.FormatSpec | undefined, target: { slot: number; isRef: boolean }) {
    if (!spec) return;
    // Evaluate each argument exactly once, in order.
    const argSlots = spec.args.map((a) => {
      const slot = this.newSlot();
      this.expr(a);
      this.emit(Op.STORE, slot);
      return slot;
    });
    for (const piece of spec.pieces) {
      if (piece.kind === "text") {
        this.appendText(target.slot, piece.text, target.isRef);
      } else {
        const arg = spec.args[piece.arg];
        const flags = (piece.debug ? 1 : 0) | (piece.pretty ? 2 : 0);
        this.appendFmt(target.slot, argSlots[piece.arg], this.ty(arg.id), flags, piece.precision ?? -1, target.isRef);
      }
    }
  }
}

function collectIdents(p: A.Pattern, f: (id: A.NodeId, name: string) => void) {
  switch (p.kind) {
    case "ident": f(p.id, p.name); if (p.sub) collectIdents(p.sub, f); return;
    case "tuple": case "tupleStruct": p.elems.forEach((x) => collectIdents(x, f)); return;
    case "struct": p.fields.forEach((x) => collectIdents(x.pat, f)); return;
    case "ref": collectIdents(p.inner, f); return;
    case "or": p.alts.forEach((x) => collectIdents(x, f)); return;
  }
}

/** How each instruction changes the operand stack depth. */
function stackEffect(op: number, operands: number[]): number {
  switch (OPS[op].name) {
    case "CONST": case "UNIT": case "TRUE": case "FALSE": case "DUP": case "LOAD": case "REF_LOCAL": case "NEW_STRING": case "DEFAULT": return 1;
    case "POP": case "STORE": case "JUMP_IF_FALSE": case "JUMP_IF_TRUE": case "PANIC": case "PRINT": case "RET": return -1;
    case "STORE_REF": case "STR_APPEND": case "FMT": return -2;
    case "INDEX_REF": case "INDEX_GET": case "ADD": case "SUB": case "MUL": case "DIV": case "REM": case "BITAND": case "BITOR": case "BITXOR":
    case "SHL": case "SHR": case "EQ": case "NE": case "LT": case "LE": case "GT": case "GE": case "DEEP_EQ": case "DEEP_CMP": return -1;
    case "MAKE_AGG": return 1 - operands[1];
    case "CALL": case "INTRINSIC": return 1 - operands[1];
    default: return 0;
  }
}

export { UNIT };
