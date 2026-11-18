/**
 * # Stage 5b: Checking function bodies
 *
 * One {@link FnCtxt} checks one function body. It walks every expression,
 * computes its type, and records what it learned in {@link TypeckResults}.
 *
 * ## Bidirectional checking
 *
 * Most expressions are checked with an *expected type* when one is known
 * (`let x: u8 = 5` expects `u8`), which gives better inference and better
 * error messages. The actual type is then **coerced** to the expected one.
 *
 * ## Coercions
 *
 * At *coercion sites* (let with a type, function arguments, struct fields,
 * returns) Rust allows a few implicit conversions:
 *
 * | From          | To       | Why                                 |
 * |---------------|----------|-------------------------------------|
 * | `&mut T`      | `&T`     | a unique borrow can act as shared   |
 * | `&String`     | `&str`   | deref coercion (`String: Deref<Target=str>`) |
 * | `&Box<T>`     | `&T`     | deref coercion                      |
 * | `!`           | anything | code after `return` never runs      |
 *
 * ## Method lookup ("probing")
 *
 * For `recv.method(args)` we try a sequence of receiver types, stopping at the
 * first that has a matching method:
 *
 * ```mermaid
 * flowchart LR
 *   T0["U = typeof(recv)"] --> V0["try U"] --> R0["try &U"] --> M0["try &mut U"]
 *   M0 -->|"not found: deref U"| T1["U = *U"] --> V1["try U"] --> R1["try &U"] --> M1["try &mut U"]
 * ```
 *
 * "Try `R`" means: is there an inherent or trait method whose `self`
 * parameter type unifies with `R`? That single rule explains why `v.len()`
 * works on `Vec<T>`, `&Vec<T>` and `&mut Vec<T>` alike, and why
 * `s.len()` on a `String` finds `str::len` (by dereferencing `String` to `str`).
 *
 * ## Match ergonomics
 *
 * When a non-reference pattern like `Some(x)` meets a *reference* like
 * `&Option<T>`, the checker peels the reference and switches the *default
 * binding mode* to `ref`, so `x` binds as `&T`. That's why
 * `match &opt { Some(x) => .. }` doesn't move out of `opt`.
 */
import type { Diagnostics, Span } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { Def, DefId, PartialRes } from "../resolve/defs.ts";
import { InferCtxt } from "./infer.ts";
import { isRestPat } from "./exhaustive.ts";
import type { Adjustment, BindingMode, Callee, ClosureInfo, ClosureKind, DerefStep, TypeckResults } from "./results.ts";
import { headKey, primTy, type Predicate, type TyCtxt } from "./tcx.ts";
import { TraitSolver } from "./traits.ts";
import {
  BOOL, CHAR, ERROR, NEVER, REF_STR, STR, UNIT, USIZE, containsKind, isSigned, isUnit, mapTy, showTy, substitute,
  type Subst, type Ty,
} from "./types.ts";

type Obligation =
  | { kind: "trait"; self: Ty; trait: DefId; args: Ty[]; span: Span; why?: string }
  | { kind: "proj"; proj: Extract<Ty, { k: "proj" }>; ty: Ty; span: Span };

interface LoopCtx {
  breakTy: Ty;
  sawBreak: boolean;
  isLoop: boolean;
}

/** What a value path (`x`, `None`, `Point::new`, `i32::MAX`) denotes before it's called. */
type ValuePath =
  | { kind: "local"; ty: Ty }
  | { kind: "fn"; def: DefId; subst: Subst }
  | { kind: "ctor"; def: DefId; adtDef: DefId; adtArgs: Ty[] }
  | { kind: "const"; def: DefId; subst: Subst }
  | { kind: "static"; def: DefId }
  | { kind: "constParam"; def: DefId }
  | { kind: "err" };

interface MethodPick {
  def: DefId;
  subst: Subst;
  adjust: Adjustment;
}

export class FnCtxt {
  readonly infcx = new InferCtxt();
  readonly solver: TraitSolver;
  private readonly obligations: Obligation[] = [];
  private readonly loops = new Map<A.NodeId, LoopCtx>();
  private retTy: Ty = UNIT;
  /** Greater than zero inside `unsafe` code. */
  private unsafeDepth = 0;
  /** Set while checking the operand of `&raw`, which may name a place without reading it. */
  private rawOperand = false;
  private readonly myClosures: ClosureInfo[] = [];
  private readonly opaqueVars = new Map<number, Ty>();
  /** Inherent impls and trait methods are indexed once, lazily. */
  private static traitsByMethod?: Map<string, DefId[]>;

  private readonly tcx: TyCtxt;
  private readonly diags: Diagnostics;
  private readonly out: TypeckResults;
  private readonly def: DefId;
  private readonly defs: Def[];

  constructor(tcx: TyCtxt, def: DefId, out: TypeckResults) {
    this.tcx = tcx;
    this.diags = tcx.diags;
    this.out = out;
    this.def = def;
    this.defs = tcx.defs;
    this.solver = new TraitSolver(tcx, this.infcx, tcx.predicates(def));
  }

  // =========================================================================
  // Entry points
  // =========================================================================

  checkFn(fn: A.FnItem) {
    const sig = this.tcx.fnSig(this.def);
    const params = sig.params.map((p) => this.normalize(p, fn.span));
    this.retTy = this.defineOpaques(this.normalize(sig.ret, fn.span), fn.span);
    if (fn.isUnsafe) this.unsafeDepth++; // an `unsafe fn` body is an unsafe context in editions before 2024
    let i = 0;
    if (fn.selfParam) {
      this.out.locals.set(fn.selfParam.id, { name: "self", ty: params[0], mutable: fn.selfParam.mutable, span: fn.selfParam.span });
      this.out.types.set(fn.selfParam.id, params[0]);
      this.out.bindingModes.set(fn.selfParam.id, "move");
      i = 1;
    }
    for (const p of fn.params) {
      this.checkPat(p.pat, params[i++], "move");
      this.checkIrrefutable(p.pat, "function argument");
    }
    if (!fn.body) return;
    const bodyTy = this.checkExpr(fn.body, this.retTy);
    this.coerce(fn.body.tail ?? fn.body, bodyTy, this.retTy, fn.body.tail ? fn.body.tail.span : fn.body.span, () => {
      if (!fn.body!.tail && fn.ret) return `this function's body has no tail expression; it implicitly returns \`()\``;
      return undefined;
    });
    this.finish();
  }

  /** Inside its own function, an `impl Trait` is an unknown type that must satisfy the bounds. */
  private defineOpaques(t: Ty, span: Span): Ty {
    const go = (t: Ty): Ty => {
      if (t.k !== "opaque" || t.def !== this.def) return mapTy(t, go);
      let v = this.opaqueVars.get(t.index);
      if (!v) {
        v = this.infcx.newVar();
        this.opaqueVars.set(t.index, v);
        const self = v;
        const swap = (x: Ty): Ty => (x.k === "opaque" && x.index === t.index ? self : mapTy(x, swap));
        for (const p of this.tcx.opaquePredicates(t)) {
          if (p.kind === "trait") this.require(self, p.trait, p.args.map(swap), span);
          else {
            const n = this.normalize({ k: "proj", trait: p.trait, traitArgs: p.traitArgs.map(swap), self, name: p.name }, span);
            this.infcx.unify(n, this.normalize(swap(p.ty), span));
          }
        }
      }
      return v;
    };
    return go(t);
  }

  private requireUnsafe(span: Span, what: string) {
    if (this.unsafeDepth > 0) return;
    this.diags.error("typeck", span, `${what} is unsafe and requires unsafe function or block`, "E0133")
      .note("wrap this in an `unsafe { .. }` block once you have checked its safety requirements");
  }

  checkConst(c: A.ConstItem, ty: Ty) {
    const actual = this.checkExpr(c.value, ty);
    this.coerce(c.value, actual, ty, c.value.span);
    this.finish();
  }

  /** Solve remaining obligations, apply literal defaults, and make all recorded types concrete. */
  private finish() {
    this.processObligations(false);
    this.infcx.applyDefaults();
    this.processObligations(true);
    this.checkDeferredNumeric();
    this.checkIntLiterals();
    this.writeback();
    for (const [index, v] of this.opaqueVars) {
      const hidden = this.infcx.resolve(v);
      const o = this.tcx.opaques.get(index);
      if (o) o.hidden = hidden;
    }
  }

  /** Operators applied while an operand's type was still unknown; checked in `finish`. */
  private readonly deferredNumeric: { ty: Ty; span: Span; op: string }[] = [];

  private readonly intLits: { value: number; ty: Ty; span: Span; negated: boolean }[] = [];
  private readonly negatedLits = new Set<A.NodeId>();

  /** rustc's `overflowing_literals` lint (deny by default): `let x: u8 = 300;` */
  private checkIntLiterals() {
    const ranges: Record<string, [number, number]> = {
      i8: [-128, 127], i16: [-32768, 32767], i32: [-2147483648, 2147483647], u8: [0, 255], u16: [0, 65535], u32: [0, 4294967295],
    };
    for (const l of this.intLits) {
      const t = this.infcx.resolve(l.ty);
      if (t.k !== "int" || !(t.name in ranges)) continue;
      const [lo, hi] = ranges[t.name];
      // Literals are unsigned: `-128` is `-(128)`, so a negated literal may be one past the maximum.
      const max = l.negated && t.name.startsWith("i") ? hi + 1 : hi;
      if (l.value > max || l.value < lo) {
        this.diags.error("typeck", l.span, `literal out of range for \`${t.name}\``)
          .note(`the literal \`${l.value}\` does not fit into the type \`${t.name}\` whose range is \`${lo}..=${hi}\``);
      }
    }
  }

  private checkDeferredNumeric() {
    for (const d of this.deferredNumeric) {
      const t = this.infcx.resolve(d.ty);
      const ok = t.k === "int" || t.k === "float" || t.k === "error" || (t.k === "bool" && ["&", "|", "^", "&=", "|=", "^="].includes(d.op));
      if (!ok) {
        this.diags.error("typeck", d.span, `binary operation \`${d.op}\` cannot be applied to type \`${this.show(t)}\``, "E0369")
          .note("TSRust resolves operators on values of not-yet-known type as built-in numeric operations; add a type annotation");
      }
    }
  }

  private writeback() {
    const r = this.out;
    const reported = new Set<number>();
    const fix = (t: Ty, span?: Span): Ty => {
      const resolved = this.infcx.resolve(t);
      if (containsKind(resolved, ["var"])) {
        if (span && !reported.has(span.start)) {
          reported.add(span.start);
          if (!this.diags.hasErrors) {
            this.diags.error("typeck", span, `type annotations needed`, "E0282")
              .note(`cannot infer the type \`${this.show(resolved)}\``);
          }
        }
        return replaceVars(resolved);
      }
      return resolved;
    };
    // The checker writes provisional types into the shared tables; resolve them now.
    for (const [id, t] of r.types) if (this.mine.has(id)) r.types.set(id, fix(t, this.spans.get(id)));
    for (const [id, c] of r.callees) if (this.mine.has(id)) r.callees.set(id, { def: c.def, substs: c.substs.map((t) => fix(t, this.spans.get(id))) });
    for (const [id, c] of r.ctors) if (this.mine.has(id)) r.ctors.set(id, { def: c.def, adtArgs: c.adtArgs.map((t) => fix(t)) });
    for (const [id, l] of r.locals) {
      if (!this.mine.has(id)) continue;
      l.ty = fix(l.ty, l.span);
      if (l.ty.k === "slice" || l.ty.k === "str") {
        this.diags.error("typeck", l.span, `the size for values of type \`${this.show(l.ty)}\` cannot be known at compilation time`, "E0277")
          .note("all local variables must have a statically known size");
      }
    }
    for (const c of this.myClosures) {
      c.params = c.params.map((t) => fix(t, c.node.span));
      c.ret = fix(c.ret, c.node.span);
    }
    for (const [id, t] of r.constParams) if (this.mine.has(id)) r.constParams.set(id, fix(t));
    for (const [id, f] of r.forLoops) {
      if (!this.mine.has(id)) continue;
      r.forLoops.set(id, {
        intoIter: { def: f.intoIter.def, substs: f.intoIter.substs.map((t) => fix(t)) },
        next: { def: f.next.def, substs: f.next.substs.map((t) => fix(t)) },
        iterTy: fix(f.iterTy), itemTy: fix(f.itemTy),
      });
    }
  }

  /** Node ids written by this FnCtxt, so writeback only touches its own entries. */
  private readonly mine = new Set<A.NodeId>();
  private readonly spans = new Map<A.NodeId, Span>();

  private record(id: A.NodeId, t: Ty, span?: Span): Ty {
    this.out.types.set(id, t);
    this.mine.add(id);
    if (span) this.spans.set(id, span);
    return t;
  }

  private recordCallee(id: A.NodeId, def: DefId, subst: Subst, span: Span) {
    const params = this.tcx.allParams(def);
    this.out.callees.set(id, { def, substs: params.map((p) => subst.get(p) ?? ERROR) });
    this.mine.add(id);
    this.spans.set(id, span);
  }

  private recordCtor(id: A.NodeId, def: DefId, adtArgs: Ty[]) {
    this.out.ctors.set(id, { def, adtArgs });
    this.mine.add(id);
  }

  // =========================================================================
  // Diagnostics helpers
  // =========================================================================

  show(t: Ty): string {
    return showTy(this.infcx.resolve(t), this.tcx.nameOf, (id) => {
      const k = this.infcx.kindOf(id);
      return k === "int" ? "{integer}" : k === "float" ? "{float}" : "_";
    });
  }

  private mismatch(span: Span, expected: Ty, actual: Ty, note?: string) {
    if (containsKind(this.infcx.resolve(expected), ["error"]) || containsKind(this.infcx.resolve(actual), ["error"])) return;
    const b = this.diags.error("typeck", span, "mismatched types", "E0308");
    b.diag.labels[0].message = `expected \`${this.show(expected)}\`, found \`${this.show(actual)}\``;
    if (note) b.note(note);
    const e = this.infcx.resolve(expected), a = this.infcx.resolve(actual);
    if (e.k === "adt" && this.tcx.isLang(e.def, "String") && a.k === "ref" && a.inner.k === "str") {
      b.help("try using a conversion method: `.to_string()` or `String::from(...)`");
    } else if (e.k === "ref" && !(a.k === "ref")) {
      b.help(`consider borrowing here: \`&${e.mutable ? "mut " : ""}\``);
    }
  }

  private normalize(t: Ty, span: Span): Ty {
    return this.solver.normalizeDeep(t, (proj) => {
      const v = this.infcx.newVar();
      this.obligations.push({ kind: "proj", proj, ty: v, span });
      return v;
    });
  }

  // =========================================================================
  // Obligations
  // =========================================================================

  private require(self: Ty, trait: DefId, args: Ty[], span: Span, why?: string) {
    this.obligations.push({ kind: "trait", self, trait, args, span, why });
  }

  private requireLang(self: Ty, name: string, span: Span, why?: string) {
    const t = this.tcx.res.lang.get(name);
    if (t !== undefined) this.require(self, t, [], span, why);
  }

  private registerPredicates(preds: Predicate[], subst: Subst, span: Span) {
    for (const p of preds) {
      if (p.kind === "trait") {
        this.require(this.normalize(substitute(p.self, subst), span), p.trait, p.args.map((a) => this.normalize(substitute(a, subst), span)), span);
      } else {
        const proj: Ty = { k: "proj", trait: p.trait, traitArgs: p.traitArgs.map((a) => substitute(a, subst)), self: substitute(p.self, subst), name: p.name };
        const n = this.normalize(proj, span);
        if (!this.infcx.unify(n, this.normalize(substitute(p.ty, subst), span))) {
          this.diags.error("typeck", span, `type mismatch resolving \`${this.show(proj)} == ${this.show(substitute(p.ty, subst))}\``, "E0271");
        }
      }
    }
  }

  /** Try to discharge pending obligations. With `final`, anything left is an error. */
  processObligations(final: boolean) {
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < this.obligations.length; i++) {
        const o = this.obligations[i];
        if (o.kind === "proj") {
          const n = this.solver.normalize(o.proj);
          if (n === undefined) continue;
          if (!this.infcx.unify(n, o.ty)) {
            this.diags.error("typeck", o.span, `type mismatch resolving \`${this.show(o.proj)}\`: expected \`${this.show(o.ty)}\`, found \`${this.show(n)}\``, "E0271");
          }
        } else {
          const sel = this.solver.select(o.self, o.trait, o.args);
          if (sel.kind === "ambiguous") continue;
          this.noteClosureRequirement(o);
          if (sel.kind === "none") this.reportUnsatisfied(o);
          if (sel.kind === "impl" && sel.pending) {
            // Re-check the impl's where-clauses once more is known.
            for (const p of this.tcx.predicates(sel.impl)) {
              if (p.kind === "trait") this.obligations.push({ kind: "trait", self: substitute(p.self, sel.subst), trait: p.trait, args: p.args.map((a) => substitute(a, sel.subst)), span: o.span });
            }
          }
        }
        this.obligations.splice(i, 1);
        i--;
        progress = true;
      }
    }
    if (final) {
      for (const o of this.obligations) {
        if (this.diags.hasErrors) break;
        if (o.kind === "trait") {
          this.diags.error("typeck", o.span, `type annotations needed: cannot satisfy \`${this.show(o.self)}: ${this.tcx.nameOf(o.trait)}\``, "E0283");
        } else {
          this.diags.error("typeck", o.span, `type annotations needed: cannot resolve \`${this.show(o.proj)}\``, "E0284");
        }
      }
      this.obligations.length = 0;
    }
  }

  /** A closure's kind isn't known yet: remember which `Fn*` bound it must meet. */
  private noteClosureRequirement(o: Extract<Obligation, { kind: "trait" }>) {
    const self = this.infcx.shallow(o.self);
    if (self.k !== "closure" || !this.tcx.isFnFamily(o.trait)) return;
    this.out.closures.get(self.id)?.required.push({ kind: this.tcx.nameOf(o.trait) as ClosureKind, span: o.span });
  }

  private reportUnsatisfied(o: Extract<Obligation, { kind: "trait" }>) {
    const self = this.infcx.resolve(o.self);
    if (containsKind(self, ["error"])) return;
    if (self.k === "closure" && this.tcx.isFnFamily(o.trait)) {
      if (this.diags.hasErrors) return; // the closure itself was already reported
      const have = this.out.closures.get(self.id)?.params.length ?? 0;
      const args = this.infcx.resolve(o.args[0]);
      const want = args.k === "tuple" ? args.elems.length : have;
      if (have !== want) this.diags.error("typeck", o.span, `closure is expected to take ${want} argument${want === 1 ? "" : "s"}, but it takes ${have} argument${have === 1 ? "" : "s"}`, "E0593");
      else this.diags.error("typeck", o.span, "type mismatch in closure arguments", "E0631");
      return;
    }
    const name = this.tcx.nameOf(o.trait);
    const args = o.args.length ? `<${o.args.map((a) => this.show(a)).join(", ")}>` : "";
    const traitName = this.solver.traitName(o.trait);
    let msg = `the trait bound \`${this.show(self)}: ${name}${args}\` is not satisfied`;
    if (traitName === "Display") msg = `\`${this.show(self)}\` doesn't implement \`std::fmt::Display\``;
    if (traitName === "Debug") msg = `\`${this.show(self)}\` doesn't implement \`Debug\``;
    if (traitName === "Copy") msg = `the trait \`Copy\` is not implemented for \`${this.show(self)}\``;
    const b = this.diags.error("typeck", o.span, msg, "E0277");
    if (o.why) b.note(o.why);
    if (traitName === "Display") b.note(`in format strings you may be able to use \`{:?}\` (or {:#?} for pretty-print) instead`);
    if (traitName === "Debug" && self.k === "adt") b.help(`add \`#[derive(Debug)]\` to \`${this.tcx.nameOf(self.def)}\``);
    if ((traitName === "PartialEq" || traitName === "Clone" || traitName === "PartialOrd") && self.k === "adt") {
      b.help(`consider annotating \`${this.tcx.nameOf(self.def)}\` with \`#[derive(${traitName})]\``);
    }
  }

  // =========================================================================
  // Coercion
  // =========================================================================

  /**
   * Coerce `actual` to `expected` at a coercion site. Reports E0308 on failure.
   * `site` is the expression being coerced (for recording deref coercions).
   */
  coerce(site: A.Expr | undefined, actual: Ty, expected: Ty, span: Span, note?: () => string | undefined): boolean {
    const a = this.infcx.shallow(actual);
    const e = this.infcx.shallow(expected);
    if (a.k === "never") {
      this.infcx.markDiverging(e);
      return true;
    }
    // `&T` → `*const T`, `&mut T` → `*mut T`, `*mut T` → `*const T`.
    if (e.k === "ptr" && (a.k === "ref" || a.k === "ptr") && (a.mutable || !e.mutable)) {
      const snap = this.infcx.snapshot();
      if (this.infcx.unify(a.inner, e.inner)) return true;
      this.infcx.rollback(snap);
    }
    // A function item or capture-free closure → `fn` pointer.
    if (e.k === "fnptr" && (a.k === "fndef" || a.k === "closure")) {
      const sig = this.tcx.callableSig(a);
      if (sig && sig.params.length === e.params.length && (e.isUnsafe || !this.isUnsafeCallable(a))) {
        const snap = this.infcx.snapshot();
        const ok = sig.params.every((p, i) => this.infcx.unify(this.normalize(p, span), e.params[i])) && this.infcx.unify(this.normalize(sig.ret, span), e.ret);
        if (ok) {
          if (a.k === "closure") this.out.closures.get(a.id)!.toFnPtr = span;
          if (site) {
            this.out.coercions.set(site.id, ["fnptr"]);
            this.mine.add(site.id);
          }
          return true;
        }
        this.infcx.rollback(snap);
      }
    }
    if (a.k === "ref" && e.k === "ref" && (a.mutable || !e.mutable)) {
      const snap = this.infcx.snapshot();
      if (this.infcx.unify(a.inner, e.inner)) return true;
      this.infcx.rollback(snap);
      // Deref coercion: &String → &str, &Box<T> → &T, &&T → &T.
      const steps: DerefStep[] = [];
      let cur = this.infcx.shallow(a.inner);
      for (let i = 0; i < 8; i++) {
        const next = this.derefOnce(cur);
        if (!next) break;
        steps.push(next.step);
        cur = this.infcx.shallow(next.ty);
        const snap2 = this.infcx.snapshot();
        if (this.infcx.unify(cur, e.inner)) {
          if (site) {
            this.out.coercions.set(site.id, steps);
            this.mine.add(site.id);
          }
          return true;
        }
        this.infcx.rollback(snap2);
      }
    }
    if (this.infcx.unify(a, e)) return true;
    this.mismatch(span, expected, actual, note?.());
    return false;
  }

  private isUnsafeCallable(t: Ty): boolean {
    if (t.k === "fnptr") return !!t.isUnsafe;
    return t.k === "fndef" && this.defs[t.def].kind === "fn" && (this.defs[t.def].node as A.FnItem).isUnsafe;
  }

  /** One built-in deref step, if the type supports it. */
  private derefOnce(t: Ty): { ty: Ty; step: DerefStep } | undefined {
    t = this.infcx.shallow(t);
    if (t.k === "ref") return { ty: t.inner, step: "ref" };
    if (t.k === "adt" && this.tcx.isLang(t.def, "Box")) return { ty: t.args[0], step: "box" };
    if (t.k === "adt" && this.tcx.isLang(t.def, "String")) return { ty: STR, step: "string" };
    if (t.k === "adt" && this.tcx.isLang(t.def, "Vec")) return { ty: { k: "slice", elem: t.args[0] }, step: "vec" };
    if (t.k === "array") return { ty: { k: "slice", elem: t.elem }, step: "unsize" };
    return undefined;
  }

  /** The sequence of types reachable by auto-deref, starting with `t` itself. */
  private autoderef(t: Ty): { ty: Ty; steps: DerefStep[] }[] {
    const out = [{ ty: this.infcx.shallow(t), steps: [] as DerefStep[] }];
    for (let i = 0; i < 8; i++) {
      const last = out[out.length - 1];
      const n = this.derefOnce(last.ty);
      if (!n) break;
      out.push({ ty: this.infcx.shallow(n.ty), steps: [...last.steps, n.step] });
    }
    return out;
  }

  // =========================================================================
  // Expressions
  // =========================================================================

  checkExprCoerce(e: A.Expr, expected: Ty): Ty {
    const t = this.checkExpr(e, expected);
    this.coerce(e, t, expected, e.span);
    return expected;
  }

  checkExpr(e: A.Expr, expected?: Ty): Ty {
    const t = this.checkExprInner(e, expected);
    return this.record(e.id, t, e.span);
  }

  private checkExprInner(e: A.Expr, expected?: Ty): Ty {
    switch (e.kind) {
      case "lit": {
        const t = this.checkLit(e.value, expected);
        if (e.value.kind === "int") this.intLits.push({ value: e.value.value, ty: t, span: e.span, negated: this.negatedLits.has(e.id) });
        return t;
      }
      case "path": return this.checkPathExpr(e);
      case "unary": return this.checkUnary(e, expected);
      case "ref": {
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        const innerExpected = exp?.k === "ref" || exp?.k === "ptr" ? exp.inner : undefined;
        if (e.raw) this.rawOperand = true;
        const inner = this.checkExpr(e.expr, innerExpected);
        this.rawOperand = false;
        return e.raw ? { k: "ptr", mutable: e.mutable, inner } : { k: "ref", mutable: e.mutable, inner };
      }
      case "array": {
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        const elem = exp?.k === "array" || exp?.k === "slice" ? exp.elem : this.infcx.newVar();
        for (const x of e.elems) this.checkExprCoerce(x, elem);
        return { k: "array", elem, len: { k: "constval", n: e.elems.length } };
      }
      case "repeat": {
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        const elem = exp?.k === "array" || exp?.k === "slice" ? exp.elem : this.infcx.newVar();
        this.checkExprCoerce(e.value, elem);
        this.checkExprCoerce(e.len, USIZE);
        const len = this.tcx.constToTy(e.len, {});
        const isConstValue = e.value.kind === "path" && this.out.callees.has(e.value.id);
        if (!(len.k === "constval" && len.n <= 1) && !isConstValue) this.requireLang(elem, "Copy", e.value.span, "`[x; n]` copies `x`");
        return { k: "array", elem, len };
      }
      case "closure": return this.checkClosure(e, expected);
      case "binary": return this.checkBinary(e);
      case "assign": return this.checkAssign(e);
      case "call": return this.checkCall(e, expected);
      case "methodCall": return this.checkMethodCall(e);
      case "field": return this.checkField(e);
      case "index": return this.checkIndex(e);
      case "structLit": return this.checkStructLit(e, expected);
      case "tuple": {
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        const elems = e.elems.map((x, i) => {
          const hint = exp?.k === "tuple" ? exp.elems[i] : undefined;
          const t = this.checkExpr(x, hint);
          if (hint) { this.coerce(x, t, hint, x.span); return hint; }
          return t;
        });
        return { k: "tuple", elems };
      }
      case "block": {
        if (!e.isUnsafe) return this.checkBlock(e, expected);
        this.unsafeDepth++;
        const t = this.checkBlock(e, expected);
        this.unsafeDepth--;
        return t;
      }
      case "if": return this.checkIf(e, expected);
      case "while": {
        this.checkExprCoerce(e.cond, BOOL);
        this.loops.set(e.id, { breakTy: UNIT, sawBreak: false, isLoop: false });
        this.checkBlockUnit(e.body);
        return UNIT;
      }
      case "loop": {
        const ctx: LoopCtx = { breakTy: expected ?? this.infcx.newVar(), sawBreak: false, isLoop: true };
        this.loops.set(e.id, ctx);
        this.checkBlockUnit(e.body);
        return ctx.sawBreak ? ctx.breakTy : NEVER;
      }
      case "for": return this.checkFor(e);
      case "break": {
        const target = this.tcx.res.labels.get(e.id);
        const ctx = target !== undefined ? this.loops.get(target) : undefined;
        if (ctx) {
          ctx.sawBreak = true;
          if (e.value) {
            if (!ctx.isLoop) {
              this.diags.error("typeck", e.span, "`break` with value from a `while` or `for` loop", "E0571")
                .note("only `loop` can produce a value with `break`");
              this.checkExpr(e.value);
            } else {
              this.checkExprCoerce(e.value, ctx.breakTy);
            }
          } else if (ctx.isLoop) {
            this.coerce(undefined, UNIT, ctx.breakTy, e.span);
          }
        } else if (e.value) {
          this.checkExpr(e.value);
        }
        return NEVER;
      }
      case "continue": return NEVER;
      case "return": {
        if (e.value) this.checkExprCoerce(e.value, this.retTy);
        else this.coerce(undefined, UNIT, this.retTy, e.span, () => "`return;` with no value returns `()`");
        return NEVER;
      }
      case "match": return this.checkMatch(e, expected);
      case "range": return this.checkRange(e);
      case "cast": return this.checkCast(e);
      case "try": return this.checkTry(e);
      case "macro": return this.checkMacro(e, expected);
    }
  }

  private checkLit(lit: A.Literal, expected?: Ty): Ty {
    switch (lit.kind) {
      case "int": {
        if (lit.suffix) return primTy(lit.suffix);
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        // An unsuffixed literal where a float is expected (`let x: f64 = 1;`) is still an error in Rust.
        return exp?.k === "int" ? exp : this.infcx.newVar("int");
      }
      case "float": {
        if (lit.suffix) return primTy(lit.suffix);
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        return exp?.k === "float" ? exp : this.infcx.newVar("float");
      }
      case "bool": return BOOL;
      case "char": return CHAR;
      case "str": return REF_STR;
    }
  }

  private checkBlockUnit(b: A.BlockExpr) {
    const t = this.checkExpr(b, UNIT);
    this.coerce(b.tail ?? b, t, UNIT, b.tail?.span ?? b.span);
  }

  private checkBlock(b: A.BlockExpr, expected?: Ty): Ty {
    let diverges = false;
    for (const s of b.stmts) {
      if (s.kind === "let") {
        const declared = s.ty ? this.tcx.astToTy(s.ty, { selfTy: this.tcx.selfTyOf(this.def), fresh: () => this.infcx.newVar() }) : undefined;
        const normDeclared = declared ? this.normalize(declared, s.ty!.span) : undefined;
        let ty: Ty;
        if (s.init) {
          const initTy = this.checkExpr(s.init, normDeclared);
          if (normDeclared) { this.coerce(s.init, initTy, normDeclared, s.init.span); ty = normDeclared; }
          else if (this.infcx.shallow(initTy).k === "never") {
            // `let x = return;`: `x` is a fresh variable, so `x = 5` still type checks.
            ty = this.infcx.newVar();
            this.infcx.markDiverging(ty);
          } else ty = initTy;
          if (this.infcx.shallow(initTy).k === "never") diverges = true;
        } else {
          ty = normDeclared ?? this.infcx.newVar();
        }
        this.checkPat(s.pat, ty, "move");
        this.checkIrrefutable(s.pat, "local binding");
      } else if (s.kind === "expr") {
        const t = this.checkExpr(s.expr, s.semi ? undefined : UNIT);
        if (!s.semi && !isBlockLike(s.expr)) this.coerce(s.expr, t, UNIT, s.expr.span);
        if (!s.semi && isBlockLike(s.expr)) {
          // `if c { 1 } else { 2 }` used as a statement without `;` must be `()`.
          const rt = this.infcx.shallow(t);
          if (rt.k !== "never" && !this.infcx.unify(t, UNIT)) {
            this.mismatch(s.expr.span, UNIT, t, "expressions in statement position must have type `()`; add a `;` to discard the value");
          }
        }
        if (this.infcx.shallow(t).k === "never") diverges = true;
      }
    }
    if (b.tail) {
      const t = this.checkExpr(b.tail, expected);
      return diverges && isUnit(this.infcx.shallow(t)) ? NEVER : t;
    }
    return diverges ? NEVER : UNIT;
  }

  private checkIf(e: Extract<A.Expr, { kind: "if" }>, expected?: Ty): Ty {
    this.checkExprCoerce(e.cond, BOOL);
    if (!e.else) {
      const t = this.checkExpr(e.then, UNIT);
      if (this.infcx.shallow(t).k !== "never" && !this.infcx.unify(t, UNIT)) {
        this.diags.error("typeck", e.then.tail?.span ?? e.then.span, "`if` may be missing an `else` clause", "E0317")
          .note(`expected \`()\`, found \`${this.show(t)}\``)
          .note("`if` expressions without `else` evaluate to `()`");
      }
      return UNIT;
    }
    const result = expected ?? this.infcx.newVar();
    const thenTy = this.checkExpr(e.then, result);
    const elseTy = this.checkExpr(e.else, result);
    const t1 = this.infcx.shallow(thenTy), t2 = this.infcx.shallow(elseTy);
    if (t1.k === "never" && t2.k === "never") return NEVER;
    this.coerce(e.then.tail ?? e.then, thenTy, result, e.then.tail?.span ?? e.then.span);
    const site = e.else.kind === "block" ? e.else.tail ?? e.else : e.else;
    this.coerce(site, elseTy, result, site.span, () => "`if` and `else` have incompatible types");
    return result;
  }

  private checkMatch(e: Extract<A.Expr, { kind: "match" }>, expected?: Ty): Ty {
    const scrut = this.checkExpr(e.scrutinee);
    const result = expected ?? this.infcx.newVar();
    let allNever = e.arms.length > 0;
    for (const arm of e.arms) {
      this.checkPat(arm.pat, scrut, "move");
      if (arm.guard) this.checkExprCoerce(arm.guard, BOOL);
      const t = this.checkExpr(arm.body, result);
      if (this.infcx.shallow(t).k !== "never") allNever = false;
      this.coerce(arm.body, t, result, arm.body.span, () => "`match` arms have incompatible types");
    }
    if (e.arms.length === 0) return NEVER;
    return allNever ? NEVER : result;
  }

  private checkFor(e: Extract<A.Expr, { kind: "for" }>): Ty {
    const iterTy = this.checkExpr(e.iter);
    const intoIterTrait = this.tcx.lang("IntoIterator");
    const iteratorTrait = this.tcx.lang("Iterator");
    this.processObligations(false);
    this.require(iterTy, intoIterTrait, [], e.iter.span, "`for` loops iterate over values that implement `IntoIterator`");
    const intoIterTy = this.normalize({ k: "proj", trait: intoIterTrait, traitArgs: [], self: iterTy, name: "IntoIter" }, e.iter.span);
    const itemTy = this.normalize({ k: "proj", trait: iteratorTrait, traitArgs: [], self: intoIterTy, name: "Item" }, e.iter.span);
    this.processObligations(false);
    const intoIterFn = this.tcx.traitInfo(intoIterTrait).methods.get("into_iter")!;
    const nextFn = this.tcx.traitInfo(iteratorTrait).methods.get("next")!;
    this.out.forLoops.set(e.id, {
      intoIter: { def: intoIterFn, substs: [iterTy] },
      next: { def: nextFn, substs: [intoIterTy] },
      iterTy: intoIterTy,
      itemTy,
    });
    this.mine.add(e.id);
    this.checkPat(e.pat, itemTy, "move");
    this.checkIrrefutable(e.pat, "`for` loop binding");
    this.loops.set(e.id, { breakTy: UNIT, sawBreak: false, isLoop: false });
    this.checkBlockUnit(e.body);
    return UNIT;
  }

  private checkRange(e: Extract<A.Expr, { kind: "range" }>): Ty {
    if (!e.start || !e.end) {
      const bound = e.start ?? e.end;
      const name = e.start ? "RangeFrom" : e.end ? (e.inclusive ? "RangeToInclusive" : "RangeTo") : "RangeFull";
      const args = bound ? [this.checkExpr(bound)] : [];
      const def = this.tcx.lang(name);
      this.recordCtor(e.id, def, args);
      return { k: "adt", def, args };
    }
    const start = this.checkExpr(e.start);
    const end = this.checkExpr(e.end, start);
    this.coerce(e.end, end, start, e.end.span);
    const def = this.tcx.lang(e.inclusive ? "RangeInclusive" : "Range");
    this.recordCtor(e.id, def, [start]);
    return { k: "adt", def, args: [start] };
  }

  private checkCast(e: Extract<A.Expr, { kind: "cast" }>): Ty {
    const target = this.tcx.astToTy(e.ty, { fresh: () => this.infcx.newVar() });
    const src = this.checkExpr(e.expr, this.infcx.isNumericVar(target) ? undefined : undefined);
    const s = this.infcx.shallow(src);
    const t = this.infcx.shallow(target);
    const numeric = (x: Ty) => x.k === "int" || x.k === "float" || (x.k === "var" && this.infcx.kindOf(x.id) !== "general");
    let ok = false;
    const pointee = (x: Ty) => this.infcx.shallow((x as { inner: Ty }).inner);
    if (t.k === "ptr" && s.k === "ptr") ok = true;
    else if (t.k === "ptr" && s.k === "ref" && (s.mutable || !t.mutable)) {
      const from = pointee(s), to = pointee(t);
      ok = from.k === "array" && to.k !== "array" && to.k !== "var" ? this.infcx.unify(from.elem, to) : this.infcx.unify(from, to);
    }
    else if (s.k === "ptr" && t.k === "int") ok = true;
    else if (t.k === "ptr" && (s.k === "int" || (s.k === "var" && this.infcx.kindOf(s.id) === "int"))) { this.infcx.unify(s, USIZE); ok = true; }
    else if (t.k === "fnptr" && (s.k === "fndef" || s.k === "closure")) ok = this.coerce(e.expr, s, t, e.span);
    else if (numeric(s) && numeric(t)) ok = true;
    else if ((s.k === "bool" || s.k === "char") && t.k === "int") ok = true;
    else if (s.k === "int" && s.name === "u8" && t.k === "char") ok = true;
    else if (s.k === "var" && this.infcx.kindOf(s.id) === "int" && t.k === "char") { this.infcx.unify(s, { k: "int", name: "u8" }); ok = true; }
    else if (s.k === "adt" && t.k === "int" && this.defs[s.def].kind === "enum" && this.tcx.variants(s.def).every((v) => v.fieldsKind === "unit")) ok = true;
    else if (this.infcx.unify(s, t)) ok = true;
    if (!ok && s.k !== "error") {
      if (t.k === "ptr" || s.k === "ptr") this.diags.error("typeck", e.span, `casting \`${this.show(src)}\` as \`${this.show(target)}\` is invalid`, "E0606");
      else this.diags.error("typeck", e.span, `non-primitive cast: \`${this.show(src)}\` as \`${this.show(target)}\``, "E0605")
        .note("an `as` expression can only be used to convert between primitive types or to coerce to a specific trait object");
    }
    // An unsuffixed literal being cast keeps its own default type (i32/f64).
    return target;
  }

  private checkTry(e: Extract<A.Expr, { kind: "try" }>): Ty {
    const t = this.infcx.shallow(this.checkExpr(e.expr));
    const ret = this.infcx.shallow(this.retTy);
    const opt = this.tcx.lang("Option"), res = this.tcx.lang("Result");
    if (t.k === "adt" && t.def === opt) {
      this.out.tryKinds.set(e.id, "option");
      if (!(ret.k === "adt" && ret.def === opt)) {
        this.diags.error("typeck", e.span, "the `?` operator can only be used on `Option`s in a function that returns `Option`", "E0277")
          .note(`this function returns \`${this.show(ret)}\``);
      }
      return t.args[0];
    }
    if (t.k === "adt" && t.def === res) {
      this.out.tryKinds.set(e.id, "result");
      if (!(ret.k === "adt" && ret.def === res)) {
        this.diags.error("typeck", e.span, "the `?` operator can only be used on `Result`s in a function that returns `Result`", "E0277")
          .note(`this function returns \`${this.show(ret)}\``);
      } else if (!this.infcx.unify(t.args[1], ret.args[1])) {
        this.diags.error("typeck", e.span, `\`?\` couldn't convert the error to \`${this.show(ret.args[1])}\``, "E0277")
          .note(`the error type here is \`${this.show(t.args[1])}\`; TSRust's \`?\` does not call \`From::from\` on errors`);
      }
      return t.args[0];
    }
    if (t.k !== "error") {
      this.diags.error("typeck", e.span, `the \`?\` operator can only be applied to values that implement \`Try\` (Option or Result)`, "E0277")
        .note(`found \`${this.show(t)}\``);
    }
    return ERROR;
  }

  // -------------------------------------------------------------------------
  // Macros
  // -------------------------------------------------------------------------

  private checkMacro(e: Extract<A.Expr, { kind: "macro" }>, expected?: Ty): Ty {
    if (e.format) {
      for (const piece of e.format.pieces) {
        if (piece.kind !== "hole") continue;
        const arg = e.format.args[piece.arg];
        if (!arg) continue;
        if (!this.out.types.has(arg.id) || !this.mine.has(arg.id)) this.checkExpr(arg);
        const t = this.out.types.get(arg.id)!;
        this.requireLang(t, piece.debug ? "Debug" : "Display", arg.span);
      }
      // Arguments that appear in no hole were rejected by the parser; still type-check them.
      for (const a of e.format.args) if (!this.mine.has(a.id)) this.checkExpr(a);
    }
    switch (e.name) {
      case "println": case "print": case "eprintln": case "eprint": return UNIT;
      case "format": return this.tcx.langAdt("String");
      case "write": case "writeln": {
        // The destination must be a `&mut Formatter` (or a `String`, via `&mut`).
        const target = this.checkExpr(e.args[0]);
        const t = this.infcx.resolve(target);
        const fmtTy = this.tcx.langAdt("Formatter");
        const ok = t.k === "ref" && t.mutable && t.inner.k === "adt" && (this.tcx.isLang(t.inner.def, "Formatter") || this.tcx.isLang(t.inner.def, "String"));
        if (!ok && t.k !== "error") this.mismatch(e.args[0].span, { k: "ref", mutable: true, inner: fmtTy }, target);
        // `fmt::Result` = `Result<(), fmt::Error>`
        const fmtError = this.fmtErrorTy();
        return { k: "adt", def: this.tcx.lang("Result"), args: [UNIT, fmtError] };
      }
      case "panic": case "unreachable": case "todo": case "unimplemented": return NEVER;
      case "assert": {
        this.checkExprCoerce(e.args[0], BOOL);
        return UNIT;
      }
      case "assert_eq": case "assert_ne": {
        const a = this.checkExpr(e.args[0]);
        const b = this.checkExpr(e.args[1], a);
        if (this.isSeqComparison(a, b, e.span)) {
          this.out.seqEq.add(e.id);
          this.requireLang(a, "Debug", e.span);
          this.requireLang(b, "Debug", e.span);
          return UNIT;
        }
        this.coerce(e.args[1], b, a, e.args[1].span);
        this.requireLang(a, "PartialEq", e.span);
        this.requireLang(a, "Debug", e.span);
        return UNIT;
      }
      case "vec": {
        const exp = expected ? this.infcx.shallow(expected) : undefined;
        const elem = exp?.k === "adt" && this.tcx.isLang(exp.def, "Vec") ? exp.args[0] : this.infcx.newVar();
        if (e.repeat) {
          this.checkExprCoerce(e.args[0], elem);
          this.checkExprCoerce(e.args[1], USIZE);
          this.requireLang(elem, "Clone", e.args[0].span, "`vec![x; n]` clones `x` n times");
        } else {
          for (const a of e.args) this.checkExprCoerce(a, elem);
        }
        return this.tcx.langAdt("Vec", [elem]);
      }
    }
    return ERROR;
  }

  private fmtErrorTy(): Ty {
    const fmtMod = this.tcx.defs[this.tcx.lang("Formatter")].module;
    const b = this.defs[fmtMod].scope?.types.get("Error");
    return b?.res.kind === "def" ? { k: "adt", def: b.res.def, args: [] } : ERROR;
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private fresh = () => this.infcx.newVar();

  /** Fresh substitution for all generic params of `def`, honoring explicit turbofish args on `seg`. */
  private instantiate(def: DefId, explicit?: A.TypeExpr[], span?: Span, base?: Subst): Subst {
    const subst: Subst = new Map(base);
    const all = this.tcx.allParams(def);
    const own = this.tcx.res.genericsOf.get(def) ?? [];
    for (const p of all) if (!subst.has(p)) subst.set(p, this.infcx.newVar());
    if (explicit && explicit.length) {
      if (explicit.length !== own.length) {
        this.diags.error("typeck", span!, `${this.defs[def].kind === "fn" ? "function" : "type"} takes ${own.length} generic argument(s) but ${explicit.length} were supplied`, "E0107");
      }
      own.forEach((p, i) => {
        if (explicit[i]) subst.set(p, this.tcx.astToTy(explicit[i], { selfTy: this.tcx.selfTyOf(this.def), fresh: this.fresh }));
      });
    }
    return subst;
  }

  private adtArgsFor(adtDef: DefId, seg: A.PathSegment | undefined, span: Span): Ty[] {
    const params = this.tcx.res.genericsOf.get(adtDef) ?? [];
    const explicit = seg?.generics;
    if (explicit && explicit.length) {
      return this.tcx.genericArgs(seg!, params, { selfTy: this.tcx.selfTyOf(this.def), fresh: this.fresh }, adtDef, span);
    }
    return params.map(() => this.infcx.newVar());
  }

  /** Resolve a value path. Handles locals, fns, constructors, consts and type-relative items. */
  private resolveValuePath(path: A.Path, exprId: A.NodeId): ValuePath {
    const pr = this.tcx.res.paths.get(path.id);
    if (!pr) return { kind: "err" };
    const last = path.segments[path.segments.length - 1];
    if (pr.unresolved.length === 0) {
      const r = pr.base;
      if (r.kind === "local") {
        const local = this.out.locals.get(r.id);
        return { kind: "local", ty: local?.ty ?? ERROR };
      }
      if (r.kind === "selfTy") {
        // `Self(..)` or `Self` for a tuple/unit struct.
        const self = this.tcx.selfTyOf(this.def);
        if (self?.k === "adt" && this.defs[self.def].kind === "struct") return { kind: "ctor", def: self.def, adtDef: self.def, adtArgs: self.args };
        return { kind: "err" };
      }
      if (r.kind !== "def") return { kind: "err" };
      const d = this.defs[r.def];
      switch (d.kind) {
        case "fn": return { kind: "fn", def: d.id, subst: this.instantiate(d.id, last.generics, path.span) };
        case "tyParam": if (d.isConstParam) return { kind: "constParam", def: d.id }; break;
        case "const": return (d.node as A.ConstItem).isStatic ? { kind: "static", def: d.id } : { kind: "const", def: d.id, subst: new Map() };
      }
      switch (d.kind) {
        case "struct": {
          const seg = path.segments[pr.baseIndex];
          return { kind: "ctor", def: d.id, adtDef: d.id, adtArgs: this.adtArgsFor(d.id, seg, path.span) };
        }
        case "variant": {
          // Generic args may be written on the enum (`Option::<i32>::None`) or the variant (`None::<i32>`).
          const enumSeg = path.segments[pr.baseIndex - 1];
          const seg = enumSeg?.generics ? enumSeg : last;
          return { kind: "ctor", def: d.id, adtDef: d.parent!, adtArgs: this.adtArgsFor(d.parent!, seg, path.span) };
        }
        default:
          this.diags.error("typeck", path.span, `expected value, found ${d.kind} \`${d.name}\``, "E0423");
          return { kind: "err" };
      }
    }
    // Type-relative: `Point::new`, `T::default`, `i32::MAX`, `Default::default`.
    return this.resolveAssocItem(pr, path, exprId);
  }

  private baseTyOfPartial(pr: PartialRes, path: A.Path): { ty?: Ty; trait?: DefId } {
    const r = pr.base;
    const seg = path.segments[pr.baseIndex];
    if (r.kind === "prim") return { ty: primTy(r.name) };
    if (r.kind === "selfTy") {
      const d = this.defs[r.owner];
      if (d.kind === "trait") return { ty: this.tcx.paramTy(this.tcx.traitInfo(r.owner).selfParam) };
      return { ty: this.tcx.selfTyOf(this.def) };
    }
    if (r.kind !== "def") return {};
    const d = this.defs[r.def];
    if (d.kind === "struct" || d.kind === "enum") return { ty: { k: "adt", def: d.id, args: this.adtArgsFor(d.id, seg, path.span) } };
    if (d.kind === "tyParam") return { ty: this.tcx.paramTy(d.id) };
    if (d.kind === "trait") return { trait: d.id };
    if (d.kind === "typeAlias") {
      const node = d.node as A.TypeAliasItem;
      return { ty: node.ty ? this.tcx.astToTy(node.ty, { fresh: this.fresh }) : ERROR };
    }
    return {};
  }

  private resolveAssocItem(pr: PartialRes, path: A.Path, _exprId: A.NodeId): ValuePath {
    const seg = pr.unresolved[0];
    if (pr.unresolved.length > 1) {
      this.diags.error("typeck", path.span, `ambiguous associated item path`, "E0223");
      return { kind: "err" };
    }
    const base = this.baseTyOfPartial(pr, path);
    const name = seg.name;
    // `Trait::method` — Self is unknown until arguments are checked.
    if (base.trait !== undefined) {
      const info = this.tcx.traitInfo(base.trait);
      const m = info.methods.get(name);
      if (m === undefined) {
        this.diags.error("typeck", seg.span, `cannot find method \`${name}\` in trait \`${this.tcx.nameOf(base.trait)}\``, "E0576");
        return { kind: "err" };
      }
      const subst = this.instantiate(m, seg.generics, seg.span);
      return { kind: "fn", def: m, subst };
    }
    const ty = base.ty;
    if (!ty) return { kind: "err" };
    const t = this.infcx.shallow(this.normalize(ty, path.span));
    // 1. Inherent impls.
    const key = headKey(t);
    for (const impl of key ? this.tcx.inherentImpls.get(key) ?? [] : []) {
      const item = this.tcx.implItem(impl, name);
      if (item === undefined) continue;
      const snap = this.infcx.snapshot();
      const implSubst = this.solver.instantiate(impl);
      if (!this.infcx.unify(substitute(this.tcx.implHeader(impl)!.selfTy, implSubst), t)) { this.infcx.rollback(snap); continue; }
      if (this.defs[item].kind === "const") return { kind: "const", def: item, subst: implSubst };
      return { kind: "fn", def: item, subst: this.instantiate(item, seg.generics, seg.span, implSubst) };
    }
    // 2. Trait items via bounds or impls (`T::default()`, `String::default()`).
    for (const trait of this.traitsWithMethod(name)) {
      const info = this.tcx.traitInfo(trait);
      const m = info.methods.get(name)!;
      const snap = this.infcx.snapshot();
      const subst = this.instantiate(m, seg.generics, seg.span);
      subst.set(info.selfParam, t);
      const traitArgs = this.tcx.allParams(trait).slice(1).map((p) => subst.get(p)!);
      const sel = this.solver.select(t, trait, traitArgs);
      if (sel.kind === "none") { this.infcx.rollback(snap); continue; }
      return { kind: "fn", def: m, subst };
    }
    const what = this.show(t);
    if (t.k === "var") {
      this.diags.error("typeck", seg.span, `type annotations needed`, "E0282");
    } else {
      this.diags.error("typeck", seg.span, `no function or associated item named \`${name}\` found for \`${what}\` in the current scope`, "E0599");
    }
    return { kind: "err" };
  }

  private traitsWithMethod(name: string): DefId[] {
    if (!FnCtxt.traitsByMethod || FnCtxt.traitsByMethodOwner !== this.tcx) {
      const map = new Map<string, DefId[]>();
      for (const t of this.tcx.res.traits) {
        for (const m of this.tcx.traitInfo(t).methods.keys()) {
          const list = map.get(m) ?? [];
          list.push(t);
          map.set(m, list);
        }
      }
      FnCtxt.traitsByMethod = map;
      FnCtxt.traitsByMethodOwner = this.tcx;
    }
    return FnCtxt.traitsByMethod.get(name) ?? [];
  }
  private static traitsByMethodOwner?: TyCtxt;

  private checkPathExpr(e: Extract<A.Expr, { kind: "path" }>): Ty {
    const vp = this.resolveValuePath(e.path, e.id);
    switch (vp.kind) {
      case "local": return vp.ty;
      case "const": {
        this.recordCallee(e.id, vp.def, vp.subst, e.span);
        return this.normalize(substitute(this.tcx.constTy(vp.def), vp.subst), e.span);
      }
      case "static": {
        const node = this.defs[vp.def].node as A.ConstItem;
        if (node.mutable && !this.rawOperand) this.requireUnsafe(e.span, "use of mutable static");
        this.rawOperand = false;
        this.out.statics.set(e.id, vp.def);
        return this.tcx.constTy(vp.def);
      }
      case "constParam": {
        const t = this.tcx.paramTy(vp.def);
        this.out.constParams.set(e.id, t);
        this.mine.add(e.id);
        return USIZE;
      }
      case "ctor": {
        const v = this.variantInfo(vp.def, vp.adtDef);
        if (v?.fieldsKind === "tuple") {
          // A tuple constructor used as a value is a function: `.map(Some)`.
          return { k: "fndef", def: vp.def, substs: vp.adtArgs };
        }
        if (v && v.fieldsKind !== "unit") {
          this.diags.error("typeck", e.span, `expected value, found struct variant \`${v.name}\``, "E0533");
          return ERROR;
        }
        this.recordCtor(e.id, vp.def, vp.adtArgs);
        return { k: "adt", def: vp.adtDef, args: vp.adtArgs };
      }
      case "fn":
        this.registerPredicates(this.tcx.predicates(vp.def), vp.subst, e.span);
        return { k: "fndef", def: vp.def, substs: this.tcx.allParams(vp.def).map((p) => vp.subst.get(p) ?? ERROR) };
      case "err": return ERROR;
    }
  }

  private variantInfo(def: DefId, adtDef: DefId) {
    return this.tcx.variants(adtDef).find((v) => v.def === def);
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private checkArgs(args: A.Expr[], params: Ty[], span: Span, what: string, countChecked = false) {
    if (!countChecked && args.length !== params.length) {
      this.diags.error("typeck", span, `${what} takes ${params.length} argument${params.length === 1 ? "" : "s"} but ${args.length} ${args.length === 1 ? "argument was" : "arguments were"} supplied`, "E0061");
    }
    // Closures go last: by then the other arguments may have fixed the types
    // their parameters need (`v.iter().fold(0, |sum, x| sum + x)`).
    const pass = (closures: boolean) => args.forEach((a, i) => {
      if ((a.kind === "closure") !== closures) return;
      if (i < params.length) this.checkExprCoerce(a, params[i]);
      else this.checkExpr(a);
    });
    pass(false);
    if (args.some((a) => a.kind === "closure")) {
      this.processObligations(false);
      pass(true);
    }
  }

  // -------------------------------------------------------------------------
  // Closures
  // -------------------------------------------------------------------------

  /** What the context says about a closure about to be checked. */
  private closureHint(expected?: Ty): { params?: Ty[]; ret?: Ty; kind?: ClosureKind } {
    const exp = expected ? this.infcx.shallow(expected) : undefined;
    if (exp?.k === "fnptr") return { params: exp.params, ret: exp.ret };
    if (exp?.k !== "var") return {};
    const hint: { params?: Ty[]; ret?: Ty; kind?: ClosureKind } = {};
    const same = (t: Ty) => { const s = this.infcx.shallow(t); return s.k === "var" && s.id === exp.id; };
    for (const o of this.obligations) {
      if (o.kind === "trait" && same(o.self) && this.tcx.isFnFamily(o.trait)) {
        const args = this.infcx.shallow(o.args[0]);
        if (args.k === "tuple") hint.params = args.elems;
        hint.kind ??= this.tcx.nameOf(o.trait) as ClosureKind;
      } else if (o.kind === "proj" && same(o.proj.self) && o.proj.name === "Output" && this.tcx.isFnFamily(o.proj.trait)) {
        hint.ret = o.ty;
        const args = this.infcx.shallow(o.proj.traitArgs[0]);
        if (args.k === "tuple") hint.params ??= args.elems;
      }
    }
    return hint;
  }

  private checkClosure(e: Extract<A.Expr, { kind: "closure" }>, expected?: Ty): Ty {
    const hint = this.closureHint(expected);
    const ctx = { selfTy: this.tcx.selfTyOf(this.def), fresh: this.fresh };
    if (hint.params && hint.params.length !== e.params.length) {
      this.diags.error("typeck", e.span, `closure is expected to take ${hint.params.length} argument${hint.params.length === 1 ? "" : "s"}, but it takes ${e.params.length} argument${e.params.length === 1 ? "" : "s"}`, "E0593");
      hint.params = undefined;
    }
    const params = e.params.map((p, i) => {
      const declared = p.ty ? this.normalize(this.tcx.astToTy(p.ty, ctx), p.ty.span) : undefined;
      const wanted = hint.params?.[i];
      if (declared && wanted && !this.infcx.unify(declared, wanted)) {
        this.diags.error("typeck", p.ty!.span, `type mismatch in closure arguments: expected \`${this.show(wanted)}\`, found \`${this.show(declared)}\``, "E0631");
      }
      return declared ?? wanted ?? this.infcx.newVar();
    });
    const declaredRet = e.ret ? this.normalize(this.tcx.astToTy(e.ret, ctx), e.ret.span) : undefined;
    if (declaredRet && hint.ret) this.infcx.unify(declaredRet, hint.ret);
    const ret = declaredRet ?? hint.ret ?? this.infcx.newVar();
    const info: ClosureInfo = { node: e, owner: this.def, params, ret, expectedKind: hint.kind, required: [] };
    this.out.closures.set(e.id, info);
    this.myClosures.push(info);
    e.params.forEach((p, i) => this.checkPat(p.pat, params[i], "move"));

    const savedRet = this.retTy;
    this.retTy = ret;
    const bodyTy = this.checkExpr(e.body, ret);
    const site = e.body.kind === "block" && e.body.tail ? e.body.tail : e.body;
    this.coerce(site, bodyTy, ret, site.span);
    this.retTy = savedRet;
    return { k: "closure", id: e.id, args: this.tcx.allParams(this.def).map((p) => this.tcx.paramTy(p)) };
  }

  /** `f(x)` where `f` is a value: a closure, fn pointer or anything implementing an `Fn` trait. */
  private checkValueCall(e: Extract<A.Expr, { kind: "call" }>): Ty {
    const calleeTy = this.checkExpr(e.callee);
    this.processObligations(false);
    const fail = (t: Ty) => {
      e.args.forEach((a) => this.checkExpr(a));
      if (this.infcx.shallow(t).k !== "error") this.diags.error("typeck", e.callee.span, `expected function, found \`${this.show(t)}\``, "E0618");
      return ERROR;
    };
    for (const step of this.autoderef(calleeTy)) {
      const u = this.infcx.shallow(step.ty);
      if (u.k === "var" && this.infcx.kindOf(u.id) === "general") {
        e.args.forEach((a) => this.checkExpr(a));
        this.diags.error("typeck", e.callee.span, "type annotations needed", "E0282").note("the type of this value must be known to call it");
        return ERROR;
      }
      const sig = this.tcx.callableSig(u);
      if (sig) {
        if (this.isUnsafeCallable(u)) this.requireUnsafe(e.span, "call to unsafe function");
        this.setAdjust(e.callee.id, step.steps);
        this.out.valueCalls.set(e.id, u.k === "closure" ? undefined : "Fn");
        this.mine.add(e.id);
        if (sig.params.length !== e.args.length) {
          this.diags.error("typeck", e.span, `this function takes ${sig.params.length} argument${sig.params.length === 1 ? "" : "s"} but ${e.args.length} ${e.args.length === 1 ? "argument was" : "arguments were"} supplied`, u.k === "closure" || u.k === "fnptr" ? "E0057" : "E0061");
        }
        const params = sig.params.map((p) => this.normalize(p, e.span));
        this.checkArgs(e.args, params, e.span, "this function", true);
        return this.normalize(sig.ret, e.span);
      }
      const argVars = e.args.map(() => this.infcx.newVar());
      const tuple: Ty = { k: "tuple", elems: argVars };
      for (const name of ["Fn", "FnMut", "FnOnce"] as const) {
        const trait = this.tcx.lang(name);
        const snap = this.infcx.snapshot();
        const sel = this.solver.select(u, trait, [tuple]);
        if (sel.kind === "none" || sel.kind === "ambiguous") { this.infcx.rollback(snap); continue; }
        this.setAdjust(e.callee.id, step.steps);
        this.out.valueCalls.set(e.id, name);
        this.mine.add(e.id);
        this.checkArgs(e.args, argVars, e.span, "this function", true);
        return this.normalize({ k: "proj", trait: this.tcx.lang("FnOnce"), traitArgs: [tuple], self: u, name: "Output" }, e.span);
      }
    }
    return fail(calleeTy);
  }

  private checkCall(e: Extract<A.Expr, { kind: "call" }>, _expected?: Ty): Ty {
    if (e.callee.kind !== "path") return this.checkValueCall(e);
    const vp = this.resolveValuePath(e.callee.path, e.callee.id);
    switch (vp.kind) {
      case "static": case "constParam": case "const": return this.checkValueCall(e);
      case "fn": {
        if ((this.defs[vp.def].node as A.FnItem).isUnsafe) this.requireUnsafe(e.span, "call to unsafe function");
        const sig = this.tcx.fnSig(vp.def);
        const params = sig.params.map((p) => this.normalize(substitute(p, vp.subst), e.span));
        const ret = this.normalize(substitute(sig.ret, vp.subst), e.span);
        this.registerPredicates(this.tcx.predicates(vp.def), vp.subst, e.callee.span);
        this.recordCallee(e.id, vp.def, vp.subst, e.span);
        this.checkArgs(e.args, params, e.span, `function \`${this.defs[vp.def].name}\``);
        return ret;
      }
      case "ctor": {
        const v = this.variantInfo(vp.def, vp.adtDef);
        if (!v) return ERROR;
        if (v.fieldsKind !== "tuple") {
          this.diags.error("typeck", e.span, `\`${v.name}\` is not a tuple-like constructor`, "E0618")
            .help(v.fieldsKind === "named" ? `use struct literal syntax: \`${v.name} { .. }\`` : `remove the parentheses: \`${v.name}\``);
          return ERROR;
        }
        const subst = new Map((this.tcx.res.genericsOf.get(vp.adtDef) ?? []).map((p, i) => [p, vp.adtArgs[i]]));
        const params = v.fields.map((f) => substitute(f.ty, subst));
        this.recordCtor(e.id, vp.def, vp.adtArgs);
        this.checkArgs(e.args, params, e.span, `this ${this.defs[vp.def].kind === "variant" ? "enum variant" : "struct"}`);
        return { k: "adt", def: vp.adtDef, args: vp.adtArgs };
      }
      case "local": return this.checkValueCall(e);
      case "err":
        e.args.forEach((a) => this.checkExpr(a));
        return ERROR;
    }
  }

  private checkMethodCall(e: Extract<A.Expr, { kind: "methodCall" }>): Ty {
    const recvTy = this.checkExpr(e.receiver);
    this.processObligations(false);
    const pick = this.probeMethod(recvTy, e.method, e.methodSpan, e.generics);
    if (!pick) {
      e.args.forEach((a) => this.checkExpr(a));
      return ERROR;
    }
    this.out.adjustments.set(e.receiver.id, pick.adjust);
    this.mine.add(e.receiver.id);
    if ((this.defs[pick.def].node as A.FnItem).isUnsafe) this.requireUnsafe(e.span, "call to unsafe function");
    const sig = this.tcx.fnSig(pick.def);
    const params = sig.params.map((p) => this.normalize(substitute(p, pick.subst), e.span));
    const ret = this.normalize(substitute(sig.ret, pick.subst), e.span);
    this.registerPredicates(this.tcx.predicates(pick.def), pick.subst, e.methodSpan);
    this.recordCallee(e.id, pick.def, pick.subst, e.span);
    this.checkArgs(e.args, params.slice(1), e.span, `method \`${e.method}\``);
    return ret;
  }

  /**
   * Find `name` for a receiver of type `recvTy`, trying each auto-deref step
   * by value, then `&`, then `&mut` (see the module docs).
   */
  probeMethod(recvTy: Ty, name: string, span: Span, explicit?: A.TypeExpr[]): MethodPick | undefined {
    const steps = this.autoderef(recvTy);
    for (const step of steps) {
      const u = this.infcx.shallow(step.ty);
      if (u.k === "var") {
        const kind = this.infcx.kindOf(u.id);
        if (kind !== "general") {
          this.diags.error("typeck", span, `can't call method \`${name}\` on ambiguous numeric type \`${kind === "int" ? "{integer}" : "{float}"}\``, "E0689")
            .help(`give the value a concrete type, e.g. \`let x: ${kind === "int" ? "i32" : "f64"} = ...;\` or a suffix like \`2${kind === "int" ? "i32" : ".0f64"}\``);
        } else {
          this.diags.error("typeck", span, `type annotations needed`, "E0282")
            .note(`the type of the receiver must be known to call \`.${name}()\``);
        }
        return undefined;
      }
      if (u.k === "error") return undefined;
      for (const autoref of [undefined, "ref", "mut"] as const) {
        const recv: Ty = autoref ? { k: "ref", mutable: autoref === "mut", inner: u } : u;
        const pick = this.probeInherent(u, steps, recv, name, span, explicit) ?? this.probeTraits(recv, name, span, explicit);
        if (pick) {
          pick.adjust = { derefs: step.steps, autoref };
          return pick;
        }
      }
    }
    // Nothing found: produce a helpful error.
    const t = this.infcx.resolve(recvTy);
    const field = this.findField(t, name);
    const b = this.diags.error("typeck", span, `no method named \`${name}\` found for \`${this.show(t)}\` in the current scope`, "E0599");
    if (field) b.help(`\`${name}\` is a field; to access it, remove the parentheses: \`.${name}\``);
    const traitsHaving = this.traitsWithMethod(name);
    if (traitsHaving.length && !field) b.note(`the method is provided by trait \`${this.tcx.nameOf(traitsHaving[0])}\`, which \`${this.show(t)}\` doesn't implement`);
    return undefined;
  }

  private findField(t: Ty, name: string): boolean {
    for (const s of this.autoderef(t)) {
      const u = this.infcx.shallow(s.ty);
      if (u.k === "adt" && this.defs[u.def].kind === "struct" && this.tcx.variants(u.def)[0].fields.some((f) => f.name === name)) return true;
    }
    return false;
  }

  /** Inherent methods whose `self` type unifies with `recv`. Considers impls for every autoderef step type. */
  private probeInherent(u: Ty, steps: { ty: Ty }[], recv: Ty, name: string, span: Span, explicit?: A.TypeExpr[]): MethodPick | undefined {
    const keys = new Set<string>();
    for (const s of [u, ...steps.map((x) => x.ty)]) {
      const k = headKey(this.infcx.shallow(s));
      if (k) keys.add(k);
    }
    for (const key of keys) {
      for (const impl of this.tcx.inherentImpls.get(key) ?? []) {
        const item = this.tcx.implItem(impl, name);
        if (item === undefined || this.defs[item].kind !== "fn") continue;
        const sig = this.tcx.fnSig(item);
        if (!sig.hasSelf) continue;
        const snap = this.infcx.snapshot();
        const subst = this.solver.instantiate(impl);
        const implSelf = substitute(this.tcx.implHeader(impl)!.selfTy, subst);
        const recvParam = substitute(sig.params[0], subst);
        if (this.infcx.unify(recvParam, recv) && this.implPredicatesMayHold(impl, subst)) {
          void implSelf;
          this.checkPrivacy(item, span, "method");
          return { def: item, subst: this.instantiate(item, explicit, span, subst), adjust: { derefs: [] } };
        }
        this.infcx.rollback(snap);
      }
    }
    return undefined;
  }

  /** Quick filter so `impl<T: Ord> Vec<T> { fn sort }` doesn't match `Vec<f64>`. */
  private implPredicatesMayHold(impl: DefId, subst: Subst): boolean {
    for (const p of this.tcx.predicates(impl)) {
      if (p.kind !== "trait") continue;
      const snap = this.infcx.snapshot();
      const r = this.solver.select(substitute(p.self, subst), p.trait, p.args.map((a) => substitute(a, subst)));
      this.infcx.rollback(snap);
      if (r.kind === "none") return false;
    }
    return true;
  }

  private probeTraits(recv: Ty, name: string, span: Span, explicit?: A.TypeExpr[]): MethodPick | undefined {
    // Prefer traits from where-clauses (so `T: Display` finds `fmt` on `T`).
    const traits = this.traitsWithMethod(name);
    const fromEnv = new Set(this.solver.env.flatMap((p) => (p.kind === "trait" ? [p.trait] : [])));
    const ordered = [...traits.filter((t) => fromEnv.has(t)), ...traits.filter((t) => !fromEnv.has(t))];
    for (const trait of ordered) {
      const info = this.tcx.traitInfo(trait);
      const m = info.methods.get(name)!;
      const sig = this.tcx.fnSig(m);
      if (!sig.hasSelf) continue;
      const snap = this.infcx.snapshot();
      const subst = this.instantiate(m, explicit, span);
      const self = subst.get(info.selfParam)!;
      const recvParam = substitute(sig.params[0], subst);
      if (this.infcx.unify(recvParam, recv)) {
        const traitArgs = this.tcx.allParams(trait).slice(1).map((p) => subst.get(p)!);
        const sel = this.solver.select(self, trait, traitArgs);
        if (sel.kind !== "none") return { def: m, subst, adjust: { derefs: [] } };
      }
      this.infcx.rollback(snap);
    }
    return undefined;
  }

  private checkPrivacy(item: DefId, span: Span, what: string) {
    const d = this.defs[item];
    if (d.isPub) return;
    const from = this.defs[this.def].module;
    if (this.isDescendant(from, d.module)) return;
    this.diags.error("typeck", span, `${what} \`${d.name}\` is private`, "E0624");
  }

  private isDescendant(m: DefId, ancestor: DefId): boolean {
    // Anonymous block modules (items inside fn bodies) share their parent's privacy.
    while (this.defs[ancestor].name === "{block}" && this.defs[ancestor].parent !== undefined) ancestor = this.defs[ancestor].parent!;
    for (let x: DefId | undefined = m; x !== undefined; x = this.defs[x].parent) {
      if (x === ancestor) return true;
      if (this.defs[x].kind !== "mod") return false;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Fields and indexing
  // -------------------------------------------------------------------------

  private checkField(e: Extract<A.Expr, { kind: "field" }>): Ty {
    const base = this.checkExpr(e.expr);
    this.processObligations(false);
    for (const step of this.autoderef(base)) {
      const u = this.infcx.shallow(step.ty);
      if (u.k === "tuple" && /^\d+$/.test(e.name)) {
        const i = Number(e.name);
        if (i < u.elems.length) {
          this.setAdjust(e.expr.id, step.steps);
          this.out.fieldIndices.set(e.id, i);
          return u.elems[i];
        }
      }
      if (u.k === "adt" && this.defs[u.def].kind === "struct") {
        const v = this.tcx.variants(u.def)[0];
        const i = v.fields.findIndex((f) => f.name === e.name);
        if (i >= 0) {
          const f = v.fields[i];
          if (!f.isPub && !this.isDescendant(this.defs[this.def].module, this.defs[u.def].module)) {
            this.diags.error("typeck", e.nameSpan, `field \`${e.name}\` of struct \`${this.tcx.nameOf(u.def)}\` is private`, "E0616");
          }
          this.setAdjust(e.expr.id, step.steps);
          this.out.fieldIndices.set(e.id, i);
          const subst = new Map((this.tcx.res.genericsOf.get(u.def) ?? []).map((p, j) => [p, u.args[j]]));
          return this.normalize(substitute(f.ty, subst), e.span);
        }
      }
      if (u.k === "var") break;
    }
    const t = this.infcx.resolve(base);
    if (t.k === "error") return ERROR;
    const b = this.diags.error("typeck", e.nameSpan, `no field \`${e.name}\` on type \`${this.show(t)}\``, "E0609");
    if (t.k === "var") b.note("the type must be known at this point");
    return ERROR;
  }

  private setAdjust(id: A.NodeId, derefs: DerefStep[], autoref?: "ref" | "mut") {
    this.out.adjustments.set(id, { derefs, autoref });
    this.mine.add(id);
  }

  private checkIndex(e: Extract<A.Expr, { kind: "index" }>): Ty {
    const base = this.checkExpr(e.expr);
    this.processObligations(false);
    for (const step of this.autoderef(base)) {
      const u = this.infcx.shallow(step.ty);
      if (u.k === "slice" && e.index.kind === "range") {
        // `&v[a..b]`, `&v[..]`: a view of part of a slice, array or Vec.
        this.setAdjust(e.expr.id, step.steps);
        const r = e.index;
        if (r.start) this.checkExprCoerce(r.start, USIZE);
        if (r.end) this.checkExprCoerce(r.end, USIZE);
        this.record(r.id, UNIT);
        this.out.sliceRanges.add(e.id);
        return u;
      }
      if (e.index.kind !== "range" && (u.k === "array" || u.k === "slice" || (u.k === "adt" && this.tcx.isLang(u.def, "Vec")))) {
        this.setAdjust(e.expr.id, step.steps);
        const indexTy = this.checkExpr(e.index, USIZE);
        if (this.infcx.shallow(indexTy).k !== "never" && !this.infcx.unify(indexTy, USIZE)) {
          this.diags.error("typeck", e.index.span, `the type \`[${this.show(u.k === "adt" ? u.args[0] : u.elem)}]\` cannot be indexed by \`${this.show(indexTy)}\``, "E0277");
          return ERROR;
        }
        if (u.k === "array" && u.len.k === "constval" && e.index.kind === "lit" && e.index.value.kind === "int" && e.index.value.value >= u.len.n) {
          this.diags.error("typeck", e.span, "this operation will panic at runtime")
            .note(`index out of bounds: the length is ${u.len.n} but the index is ${e.index.value.value}`);
        }
        return u.k === "adt" ? u.args[0] : u.elem;
      }
      if (u.k === "adt" && this.tcx.isLang(u.def, "HashMap")) {
        this.setAdjust(e.expr.id, step.steps);
        this.checkExprCoerce(e.index, { k: "ref", mutable: false, inner: u.args[0] });
        return u.args[1];
      }
      if (u.k === "str" && e.index.kind === "range") {
        // String slicing by byte range: `&s[1..4]`, `&s[..i]`, `&s[i..]`.
        this.setAdjust(e.expr.id, step.steps);
        const r = e.index;
        if (r.start) this.checkExprCoerce(r.start, USIZE);
        if (r.end) this.checkExprCoerce(r.end, USIZE);
        this.record(r.id, UNIT);
        this.out.strSlices.add(e.id);
        return STR;
      }
      if (u.k === "str") {
        this.checkExpr(e.index);
        this.diags.error("typeck", e.span, "the type `str` cannot be indexed by an integer", "E0277")
          .note("Rust strings are UTF-8: a byte index may fall inside a character")
          .help("use `.chars().nth(i)` for the i-th character, or a byte range like `&s[start..end]` for a substring");
        return ERROR;
      }
    }
    this.checkExpr(e.index);
    const t = this.infcx.resolve(base);
    if (t.k !== "error") this.diags.error("typeck", e.span, `cannot index into a value of type \`${this.show(t)}\``, "E0608");
    return ERROR;
  }

  // -------------------------------------------------------------------------
  // Struct literals
  // -------------------------------------------------------------------------

  private checkStructLit(e: Extract<A.Expr, { kind: "structLit" }>, _expected?: Ty): Ty {
    const pr = this.tcx.res.paths.get(e.path.id);
    if (!pr) { e.fields.forEach((f) => this.checkExpr(f.value)); return ERROR; }
    let variantDef: DefId | undefined, adtDef: DefId | undefined, adtArgs: Ty[] = [];
    const r = pr.base;
    if (pr.unresolved.length === 0 && r.kind === "def") {
      const d = this.defs[r.def];
      if (d.kind === "struct") { variantDef = adtDef = d.id; adtArgs = this.adtArgsFor(d.id, e.path.segments[pr.baseIndex], e.span); }
      else if (d.kind === "variant") {
        variantDef = d.id; adtDef = d.parent!;
        adtArgs = this.adtArgsFor(adtDef, e.path.segments[pr.baseIndex - 1], e.span);
      } else if (d.kind === "typeAlias") {
        const t = this.infcx.shallow(this.tcx.astToTy({ kind: "path", id: -1, span: e.path.span, path: e.path }, { fresh: this.fresh }));
        if (t.k === "adt" && this.defs[t.def].kind === "struct") { variantDef = adtDef = t.def; adtArgs = t.args; }
      }
    } else if (pr.unresolved.length === 0 && r.kind === "selfTy") {
      const self = this.tcx.selfTyOf(this.def);
      if (self?.k === "adt" && this.defs[self.def].kind === "struct") { variantDef = adtDef = self.def; adtArgs = self.args; }
    }
    if (variantDef === undefined || adtDef === undefined) {
      this.diags.error("typeck", e.path.span, `expected struct, variant or union type, found \`${e.path.segments.map((s) => s.name).join("::")}\``, "E0574");
      e.fields.forEach((f) => this.checkExpr(f.value));
      return ERROR;
    }
    const v = this.variantInfo(variantDef, adtDef)!;
    const subst = new Map((this.tcx.res.genericsOf.get(adtDef) ?? []).map((p, i) => [p, adtArgs[i]]));
    const adtTy: Ty = { k: "adt", def: adtDef, args: adtArgs };
    this.recordCtor(e.id, variantDef, adtArgs);
    const seen = new Set<string>();
    for (const f of e.fields) {
      const i = v.fields.findIndex((x) => x.name === f.name);
      if (i < 0) {
        this.diags.error("typeck", f.span, `struct \`${v.name}\` has no field named \`${f.name}\``, "E0560")
          .note(`available fields are: ${v.fields.map((x) => `\`${x.name}\``).join(", ")}`);
        this.checkExpr(f.value);
        continue;
      }
      if (seen.has(f.name)) this.diags.error("typeck", f.span, `field \`${f.name}\` specified more than once`, "E0062");
      seen.add(f.name);
      const field = v.fields[i];
      if (!field.isPub && !this.isDescendant(this.defs[this.def].module, this.defs[adtDef].module)) {
        this.diags.error("typeck", f.span, `field \`${f.name}\` of struct \`${v.name}\` is private`, "E0451");
      }
      this.checkExprCoerce(f.value, this.normalize(substitute(field.ty, subst), f.span));
      this.out.litFields.set(f.value.id, i);
    }
    if (e.base) {
      this.checkExprCoerce(e.base, adtTy);
    } else {
      const missing = v.fields.filter((f) => !seen.has(f.name)).map((f) => `\`${f.name}\``);
      if (missing.length && v.fieldsKind === "named") {
        this.diags.error("typeck", e.path.span, `missing field${missing.length > 1 ? "s" : ""} ${missing.join(", ")} in initializer of \`${v.name}\``, "E0063");
      }
    }
    return adtTy;
  }

  // -------------------------------------------------------------------------
  // Operators
  // -------------------------------------------------------------------------

  private isNumeric(t: Ty): "int" | "float" | undefined {
    t = this.infcx.shallow(t);
    if (t.k === "int") return "int";
    if (t.k === "float") return "float";
    const k = this.infcx.isNumericVar(t);
    return k === "int" || k === "float" ? k : undefined;
  }

  private checkUnary(e: Extract<A.Expr, { kind: "unary" }>, expected?: Ty): Ty {
    if (e.op === "*") {
      const raw = this.rawOperand;
      this.rawOperand = false;
      const t = this.infcx.shallow(this.checkExpr(e.expr));
      if (t.k === "ptr") {
        if (!raw) this.requireUnsafe(e.span, "dereference of raw pointer");
        return t.inner;
      }
      if (t.k === "ref") return t.inner;
      if (t.k === "adt" && (this.tcx.isLang(t.def, "Box") || this.tcx.isLang(t.def, "Vec") || this.tcx.isLang(t.def, "String"))) return this.derefOnce(t)!.ty;
      if (t.k !== "error") this.diags.error("typeck", e.span, `type \`${this.show(t)}\` cannot be dereferenced`, "E0614");
      return ERROR;
    }
    if (e.op === "-" && e.expr.kind === "lit") this.negatedLits.add(e.expr.id);
    let t = this.infcx.shallow(this.checkExpr(e.expr, expected));
    t = this.derefNumeric(e.expr, t) ?? t;
    if (e.op === "!") {
      if (t.k === "bool" || t.k === "never" || this.isNumeric(t) === "int") return t;
    } else {
      const num = this.isNumeric(t);
      if (num === "float") return t;
      if (num === "int") {
        if (t.k === "int" && !isSigned(t.name)) {
          this.diags.error("typeck", e.span, `cannot apply unary operator \`-\` to type \`${t.name}\``, "E0600")
            .note("unsigned values cannot be negated");
          return ERROR;
        }
        return t;
      }
      const neg = this.tcx.res.lang.get("Neg");
      if (neg !== undefined && (t.k === "adt" || t.k === "param")) return this.overloadedOp(e, neg, "neg", t, [], e.span);
    }
    if (t.k !== "error") this.diags.error("typeck", e.span, `cannot apply unary operator \`${e.op}\` to type \`${this.show(t)}\``, "E0600");
    return ERROR;
  }

  /** Resolve `lhs OP rhs` through an operator trait like `Add<Rhs>`, recording the callee. */
  private overloadedOp(e: A.Expr, trait: DefId, method: string, lhs: Ty, rhs: A.Expr[], span: Span): Ty {
    const info = this.tcx.traitInfo(trait);
    const m = info.methods.get(method)!;
    const subst = this.instantiate(m);
    subst.set(info.selfParam, lhs);
    const traitArgs = this.tcx.allParams(trait).slice(1).map((p) => subst.get(p)!);
    // Use the unique impl, if any, to learn the Rhs type before checking the operand (enables `s + &t`).
    const snap = this.infcx.snapshot();
    const sel = this.solver.select(lhs, trait, traitArgs);
    if (sel.kind === "none") {
      this.infcx.rollback(snap);
      rhs.forEach((r) => this.checkExpr(r));
      return ERROR;
    }
    const sig = this.tcx.fnSig(m);
    const params = sig.params.map((p) => this.normalize(substitute(p, subst), span));
    rhs.forEach((r, i) => this.checkExprCoerce(r, params[i + 1]));
    this.require(lhs, trait, traitArgs, span);
    this.recordCallee(e.id, m, subst, span);
    return this.normalize(substitute(sig.ret, subst), span);
  }

  /** The element type if `t` is a Vec, array or slice, behind any references. */
  private seqElem(t: Ty): Ty | undefined {
    t = this.infcx.shallow(t);
    while (t.k === "ref") t = this.infcx.shallow(t.inner);
    if (t.k === "array" || t.k === "slice") return t.elem;
    return t.k === "adt" && this.tcx.isLang(t.def, "Vec") ? t.args[0] : undefined;
  }

  /** `vec == [1, 2]`, `slice == vec`...: different sequence types compare element by element. */
  private isSeqComparison(a: Ty, b: Ty, span: Span): boolean {
    const x = this.seqElem(a), y = this.seqElem(b);
    if (!x || !y) return false;
    const head = (t: Ty) => { t = this.infcx.shallow(t); while (t.k === "ref") t = this.infcx.shallow(t.inner); return t.k; };
    if (head(a) === head(b) && this.infcx.shallow(a).k === this.infcx.shallow(b).k) return false; // ordinary `==`
    if (!this.infcx.unify(x, y)) return false;
    this.requireLang(x, "PartialEq", span);
    return true;
  }

  private checkBinary(e: Extract<A.Expr, { kind: "binary" }>): Ty {
    const op = e.op;
    if (op === "&&" || op === "||") {
      this.checkExprCoerce(e.left, BOOL);
      this.checkExprCoerce(e.right, BOOL);
      return BOOL;
    }
    const lhs = this.infcx.shallow(this.checkExpr(e.left));
    if (["==", "!=", "<", "<=", ">", ">="].includes(op)) {
      const rhs = this.checkExpr(e.right, lhs);
      const isEq = op === "==" || op === "!=";
      if (isEq && this.isSeqComparison(lhs, rhs, e.span)) {
        this.out.seqEq.add(e.id);
        return BOOL;
      }
      this.coerce(e.right, rhs, lhs, e.right.span);
      const traitName = isEq ? "PartialEq" : "PartialOrd";
      const trait = this.tcx.lang(traitName);
      const methodName = ({ "==": "eq", "!=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge" } as Record<string, string>)[op];
      if (!this.isNumeric(lhs) && !["bool", "char"].includes(lhs.k)) {
        // Record the trait method so codegen can dispatch (natively for builtins).
        const m = this.tcx.traitInfo(trait).methods.get(methodName)!;
        this.recordCallee(e.id, m, new Map([[this.tcx.traitInfo(trait).selfParam, lhs]]), e.span);
      }
      const sel = this.solver.select(lhs, trait, []);
      if (sel.kind === "none") {
        const b = this.diags.error("typeck", e.span, `binary operation \`${op}\` cannot be applied to type \`${this.show(lhs)}\``, "E0369");
        const t = this.infcx.resolve(lhs);
        if (t.k === "adt") b.note(`an implementation of \`${traitName}\` might be missing for \`${this.show(t)}\``).help(`consider annotating \`${this.tcx.nameOf(t.def)}\` with \`#[derive(${traitName})]\``);
      } else if (sel.kind === "ambiguous") {
        this.require(lhs, trait, [], e.span);
      }
      return BOOL;
    }
    // Arithmetic and bitwise. Like std's `impl Add<&i32> for &i32`, numeric
    // operands may be references: `&a + b` auto-derefs (recorded as an adjustment).
    const lhsDeref = this.derefNumeric(e.left, lhs);
    if (lhsDeref) return this.checkArith(e, lhsDeref);
    if (lhs.k === "var" && !this.infcx.isNumericVar(lhs)) {
      // Unknown yet (e.g. the item of `for i in 0..5`): assume a built-in numeric
      // op now and verify once inference has finished.
      const rhs = this.checkExpr(e.right, lhs);
      if (op !== "<<" && op !== ">>") this.coerce(e.right, rhs, lhs, e.right.span);
      this.deferredNumeric.push({ ty: lhs, span: e.span, op });
      return lhs;
    }
    const num = this.isNumeric(lhs);
    if (num || lhs.k === "bool") {
      return this.checkArith(e, lhs);
    }
    const traitName = ({ "+": "Add", "-": "Sub", "*": "Mul", "/": "Div", "%": "Rem" } as Record<string, string>)[op];
    const trait = traitName ? this.tcx.res.lang.get(traitName) : undefined;
    if (trait !== undefined && (lhs.k === "adt" || lhs.k === "param" || lhs.k === "ref" || lhs.k === "tuple")) {
      const t = this.overloadedOp(e, trait, traitName.toLowerCase(), lhs, [e.right], e.span);
      if (t.k === "error") {
        const b = this.diags.error("typeck", e.span, `cannot ${verb(op)} \`${this.show(this.out.types.get(e.right.id) ?? ERROR)}\` ${prep(op)} \`${this.show(lhs)}\``, "E0369");
        if (lhs.k === "ref" && lhs.inner.k === "str" && op === "+") {
          b.note("`+` cannot be used to concatenate two `&str` strings")
            .help("create an owned `String` from the left side: `left.to_string() + right`");
        } else if (lhs.k === "adt") {
          b.note(`an implementation of \`std::ops::${traitName}\` might be missing for \`${this.show(lhs)}\``);
        }
      }
      return t;
    }
    this.checkExpr(e.right);
    if (lhs.k !== "error") {
      this.diags.error("typeck", e.span, `cannot ${verb(op)} \`${this.show(this.out.types.get(e.right.id) ?? ERROR)}\` ${prep(op)} \`${this.show(lhs)}\``, "E0369");
    }
    return ERROR;
  }

  /** If `t` is `&N` for a numeric/bool `N`, record an auto-deref on `e` and return `N`. */
  private derefNumeric(e: A.Expr, t: Ty): Ty | undefined {
    t = this.infcx.shallow(t);
    if (t.k !== "ref") return undefined;
    const inner = this.infcx.shallow(t.inner);
    if (!this.isNumeric(inner) && inner.k !== "bool") return undefined;
    this.setAdjust(e.id, ["ref"]);
    return inner;
  }

  /** Built-in arithmetic/bitwise ops on numbers and bools. */
  private checkArith(e: Extract<A.Expr, { kind: "binary" }>, lhs: Ty): Ty {
    const op = e.op;
    const num = this.isNumeric(lhs);
    {
      const isShift = op === "<<" || op === ">>";
      let rhs = this.checkExpr(e.right, isShift ? undefined : lhs);
      rhs = this.derefNumeric(e.right, rhs) ?? rhs;
      if (isShift) {
        if (this.isNumeric(rhs) !== "int") this.mismatch(e.right.span, { k: "int", name: "u32" }, rhs);
        if (num !== "int") this.diags.error("typeck", e.span, `no implementation for \`${this.show(lhs)} ${op} ${this.show(rhs)}\``, "E0369");
        return lhs;
      }
      if (!this.infcx.unify(lhs, rhs)) {
        const r = this.infcx.resolve(rhs);
        if (r.k !== "error") {
          this.diags.error("typeck", e.span, `cannot ${verb(op)} \`${this.show(rhs)}\` ${prep(op)} \`${this.show(lhs)}\``, "E0277")
            .note(`no implementation for \`${this.show(lhs)} ${op} ${this.show(rhs)}\``)
            .help(num ? `Rust never converts numbers implicitly; use \`as\` to convert, e.g. \`x as ${this.show(lhs)}\`` : "");
        }
        return ERROR;
      }
      if (lhs.k === "bool" && !["&", "|", "^"].includes(op)) {
        this.diags.error("typeck", e.span, `cannot ${verb(op)} \`bool\` ${prep(op)} \`bool\``, "E0369");
        return ERROR;
      }
      if (num === "float" && ["&", "|", "^"].includes(op)) {
        this.diags.error("typeck", e.span, `no implementation for \`${this.show(lhs)} ${op} ${this.show(lhs)}\``, "E0369");
      }
      return lhs;
    }
  }

  private checkAssign(e: Extract<A.Expr, { kind: "assign" }>): Ty {
    if (!isPlaceExpr(e.target)) {
      this.checkExpr(e.target);
      this.checkExpr(e.value);
      this.diags.error("typeck", e.target.span, "invalid left-hand side of assignment", "E0070")
        .note("you can only assign to a variable, a field, an index, or a dereferenced reference");
      return UNIT;
    }
    const target = this.infcx.shallow(this.checkExpr(e.target));
    if (e.op === "=") {
      this.checkExprCoerce(e.value, target);
      return UNIT;
    }
    const binOp = e.op.slice(0, -1);
    if (target.k === "var" && !this.infcx.isNumericVar(target)) {
      this.checkExprCoerce(e.value, target);
      this.deferredNumeric.push({ ty: target, span: e.span, op: e.op });
      return UNIT;
    }
    if (this.isNumeric(target) || target.k === "bool") {
      let rhs = this.checkExpr(e.value, target);
      rhs = this.derefNumeric(e.value, rhs) ?? rhs;
      const isShift = binOp === "<<" || binOp === ">>";
      if (isShift && this.isNumeric(rhs) !== "int") this.mismatch(e.value.span, { k: "int", name: "u32" }, rhs);
      if (!isShift && !this.infcx.unify(target, rhs)) {
        this.diags.error("typeck", e.span, `cannot ${verb(binOp)}-assign \`${this.show(rhs)}\` ${prep(binOp)} \`${this.show(target)}\``, "E0277")
          .help("Rust never converts numbers implicitly; use `as` to convert");
      }
      return UNIT;
    }
    const traitName = ({ "+": "AddAssign", "-": "SubAssign", "*": "MulAssign" } as Record<string, string>)[binOp];
    const trait = traitName ? this.tcx.res.lang.get(traitName) : undefined;
    if (trait !== undefined && (target.k === "adt" || target.k === "param")) {
      const t = this.overloadedOp(e, trait, `${traitName.replace("Assign", "").toLowerCase()}_assign`, target, [e.value], e.span);
      if (t.k === "error") {
        this.diags.error("typeck", e.span, `binary assignment operation \`${e.op}\` cannot be applied to type \`${this.show(target)}\``, "E0368");
      }
      return UNIT;
    }
    this.checkExpr(e.value);
    if (target.k !== "error") this.diags.error("typeck", e.span, `binary assignment operation \`${e.op}\` cannot be applied to type \`${this.show(target)}\``, "E0368");
    return UNIT;
  }

  // =========================================================================
  // Patterns
  // =========================================================================

  /**
   * Check pattern `p` against a value of type `expected`, binding variables
   * with default binding `mode` (match ergonomics).
   */
  checkPat(p: A.Pattern, expected: Ty, mode: BindingMode) {
    // Match ergonomics: a non-reference pattern against a reference peels it.
    const peels = p.kind === "tuple" || p.kind === "tupleStruct" || p.kind === "struct" || p.kind === "path" || p.kind === "range" || p.kind === "slice" ||
      (p.kind === "lit" && p.value.kind !== "str") || (p.kind === "ident" && this.tcx.res.patternPaths.has(p.id));
    let derefs = 0;
    if (peels) {
      let t = this.infcx.shallow(expected);
      while (t.k === "ref") {
        mode = t.mutable && mode !== "ref" ? "refMut" : "ref";
        expected = t.inner;
        t = this.infcx.shallow(expected);
        derefs++;
      }
    } else if (p.kind === "lit" && p.value.kind === "str") {
      // A string literal pattern has type `&str`: peel only extra layers (`&&str`).
      let t = this.infcx.shallow(expected);
      while (t.k === "ref" && this.infcx.shallow(t.inner).k === "ref") {
        mode = "ref"; expected = t.inner; t = this.infcx.shallow(expected); derefs++;
      }
    }
    if (derefs) { this.out.patDerefs.set(p.id, derefs); this.mine.add(p.id); }
    this.record(p.id, expected);

    switch (p.kind) {
      case "wild": return;
      case "rest":
        this.diags.error("typeck", p.span, "`..` patterns are only allowed inside slice patterns here");
        return;
      case "slice": {
        let t = this.infcx.shallow(expected);
        const at = p.elems.findIndex(isRestPat);
        const fixed = at < 0 ? p.elems.length : p.elems.length - 1;
        if (t.k === "var" && this.infcx.kindOf(t.id) === "general") {
          const arr: Ty = { k: "array", elem: this.infcx.newVar(), len: at < 0 ? { k: "constval", n: fixed } : this.infcx.newVar() };
          this.infcx.unify(t, arr);
          t = arr;
        }
        if (t.k !== "array" && t.k !== "slice") {
          if (t.k !== "error") this.diags.error("typeck", p.span, `expected an array or slice, found \`${this.show(t)}\``, "E0529");
          return;
        }
        let restTy: Ty = { k: "slice", elem: t.elem };
        if (t.k === "array") {
          const len = this.infcx.shallow(t.len);
          if (len.k === "constval") {
            if (at < 0 ? len.n !== fixed : len.n < fixed) {
              this.diags.error("typeck", p.span, `pattern requires ${at < 0 ? "" : "at least "}${fixed} element${fixed === 1 ? "" : "s"} but array has ${len.n}`, at < 0 ? "E0527" : "E0528");
              return;
            }
            restTy = { k: "array", elem: t.elem, len: { k: "constval", n: len.n - fixed } };
          }
        }
        const elem = t.elem;
        p.elems.forEach((x, i) => {
          if (i === at) { if (x.kind === "ident") this.checkPat(x, restTy, mode); else this.record(x.id, restTy); }
          else this.checkPat(x, elem, mode);
        });
        return;
      }
      case "ident": {
        const asPath = this.tcx.res.patternPaths.get(p.id);
        if (asPath) { this.checkPathPat(p, asPath, expected); return; }
        let bindingMode: BindingMode = mode;
        let ty: Ty = expected;
        if (p.byRef) bindingMode = p.mutable ? "refMut" : "ref";
        if (bindingMode !== "move") ty = { k: "ref", mutable: bindingMode === "refMut", inner: expected };
        if (mode !== "move" && p.mutable && !p.byRef) {
          // `mut x` resets the binding mode to move in Rust 2021.
          bindingMode = "move"; ty = expected;
        }
        this.out.bindingModes.set(p.id, bindingMode);
        this.out.locals.set(p.id, { name: p.name, ty, mutable: p.mutable && !p.byRef, span: p.span });
        this.mine.add(p.id);
        if (p.sub && p.sub.kind !== "rest") this.checkPat(p.sub, expected, mode);
        return;
      }
      case "lit": {
        const t = this.checkLit(p.value, expected);
        if (!this.infcx.unify(t, expected)) this.mismatch(p.span, expected, t);
        return;
      }
      case "range": {
        const lo = this.checkLit(p.lo, expected), hi = this.checkLit(p.hi, expected);
        if (!this.infcx.unify(lo, expected) || !this.infcx.unify(hi, expected)) this.mismatch(p.span, expected, lo);
        const t = this.infcx.shallow(expected);
        if (!(t.k === "int" || t.k === "char" || t.k === "float" || this.isNumeric(t))) {
          this.diags.error("typeck", p.span, "only `char` and numeric types are allowed in range patterns", "E0029");
        }
        return;
      }
      case "tuple": {
        const t = this.infcx.shallow(expected);
        let elems: Ty[];
        if (t.k === "tuple") elems = t.elems;
        else {
          elems = p.elems.map(() => this.infcx.newVar());
          if (!this.infcx.unify(expected, { k: "tuple", elems })) {
            this.mismatch(p.span, expected, { k: "tuple", elems });
            return;
          }
        }
        if (elems.length !== p.elems.length) {
          this.diags.error("typeck", p.span, `mismatched types: expected a tuple with ${elems.length} elements, found one with ${p.elems.length} elements`, "E0308");
          return;
        }
        p.elems.forEach((x, i) => this.checkPat(x, elems[i], mode));
        return;
      }
      case "ref": {
        const t = this.infcx.shallow(expected);
        if (t.k !== "ref") {
          const inner = this.infcx.newVar();
          if (!this.infcx.unify(expected, { k: "ref", mutable: p.mutable, inner })) {
            this.mismatch(p.span, expected, { k: "ref", mutable: p.mutable, inner });
            return;
          }
          this.checkPat(p.inner, inner, "move");
          return;
        }
        if (t.mutable !== p.mutable) this.mismatch(p.span, expected, { k: "ref", mutable: p.mutable, inner: t.inner });
        this.checkPat(p.inner, t.inner, "move");
        return;
      }
      case "or":
        for (const alt of p.alts) this.checkPat(alt, expected, mode);
        return;
      case "path": {
        const pr = this.tcx.res.paths.get(p.path.id);
        if (pr) this.checkPathPat(p, pr, expected);
        return;
      }
      case "tupleStruct": case "struct": {
        const pr = this.tcx.res.paths.get(p.path.id);
        if (!pr) return;
        const target = this.ctorOfPatternPath(pr, p.path, p.span);
        if (!target) return;
        const { variant, adtDef, adtArgs } = target;
        this.recordCtor(p.id, variant.def, adtArgs);
        if (!this.infcx.unify(expected, { k: "adt", def: adtDef, args: adtArgs })) {
          this.mismatch(p.span, expected, { k: "adt", def: adtDef, args: adtArgs });
          return;
        }
        const subst = new Map((this.tcx.res.genericsOf.get(adtDef) ?? []).map((x, i) => [x, adtArgs[i]]));
        if (p.kind === "tupleStruct") {
          if (variant.fieldsKind !== "tuple") {
            this.diags.error("typeck", p.span, `expected tuple struct or tuple variant, found \`${variant.name}\``, "E0164");
            return;
          }
          if (variant.fields.length !== p.elems.length) {
            this.diags.error("typeck", p.span, `this pattern has ${p.elems.length} field${p.elems.length === 1 ? "" : "s"}, but the corresponding tuple ${this.defs[variant.def].kind === "variant" ? "variant" : "struct"} has ${variant.fields.length} field${variant.fields.length === 1 ? "" : "s"}`, "E0023");
          }
          p.elems.forEach((x, i) => this.checkPat(x, variant.fields[i] ? substitute(variant.fields[i].ty, subst) : ERROR, mode));
        } else {
          for (const f of p.fields) {
            const i = variant.fields.findIndex((x) => x.name === f.name);
            if (i < 0) {
              this.diags.error("typeck", f.span, `\`${variant.name}\` does not have a field named \`${f.name}\``, "E0026");
              continue;
            }
            this.out.fieldIndices.set(f.pat.id, i);
            this.checkPat(f.pat, substitute(variant.fields[i].ty, subst), mode);
          }
          if (!p.rest) {
            const missing = variant.fields.filter((x) => !p.fields.some((f) => f.name === x.name)).map((x) => `\`${x.name}\``);
            if (missing.length) {
              this.diags.error("typeck", p.span, `pattern does not mention field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, "E0027")
                .help("include the missing fields, or ignore them with `..`");
            }
          }
        }
        return;
      }
    }
  }

  private ctorOfPatternPath(pr: PartialRes, path: A.Path, span: Span) {
    let variantDef: DefId | undefined, adtDef: DefId | undefined, adtArgs: Ty[] = [];
    if (pr.unresolved.length === 0 && pr.base.kind === "def") {
      const d = this.defs[pr.base.def];
      if (d.kind === "variant") { variantDef = d.id; adtDef = d.parent!; adtArgs = this.adtArgsFor(adtDef, path.segments[pr.baseIndex - 1], span); }
      else if (d.kind === "struct") { variantDef = adtDef = d.id; adtArgs = this.adtArgsFor(d.id, path.segments[pr.baseIndex], span); }
    } else if (pr.unresolved.length === 0 && pr.base.kind === "selfTy") {
      const self = this.tcx.selfTyOf(this.def);
      if (self?.k === "adt") { variantDef = adtDef = self.def; adtArgs = self.args; }
    }
    if (variantDef === undefined || adtDef === undefined) {
      this.diags.error("typeck", span, `expected tuple struct or tuple variant, found \`${path.segments.map((s) => s.name).join("::")}\``, "E0532");
      return undefined;
    }
    return { variant: this.variantInfo(variantDef, adtDef)!, adtDef, adtArgs };
  }

  private checkPathPat(p: A.Pattern, pr: PartialRes, expected: Ty) {
    if (pr.unresolved.length === 0 && pr.base.kind === "def" && this.defs[pr.base.def].kind === "const") {
      const t = this.tcx.constTy(pr.base.def);
      if (!this.infcx.unify(t, expected)) this.mismatch(p.span, expected, t);
      this.recordCallee(p.id, pr.base.def, new Map(), p.span);
      return;
    }
    const path = p.kind === "path" ? p.path : undefined;
    const target = this.ctorOfPatternPath(pr, path ?? { id: -1, span: p.span, segments: [{ name: (p as { name: string }).name, span: p.span }] }, p.span);
    if (!target) return;
    if (target.variant.fieldsKind !== "unit") {
      this.diags.error("typeck", p.span, `expected unit struct, unit variant or constant, found ${target.variant.fieldsKind} variant \`${target.variant.name}\``, "E0533")
        .help(target.variant.fieldsKind === "tuple" ? `use the tuple variant pattern syntax instead: \`${target.variant.name}(..)\`` : `use \`${target.variant.name} { .. }\``);
      return;
    }
    this.recordCtor(p.id, target.variant.def, target.adtArgs);
    const t: Ty = { k: "adt", def: target.adtDef, args: target.adtArgs };
    if (!this.infcx.unify(expected, t)) this.mismatch(p.span, expected, t);
  }

  /** Placeholder; refutability is checked with exhaustiveness after inference. */
  private checkIrrefutable(_p: A.Pattern, _what: string) {}
}

function isBlockLike(e: A.Expr): boolean {
  return ["block", "if", "match", "loop", "while", "for"].includes(e.kind);
}

export function isPlaceExpr(e: A.Expr): boolean {
  return e.kind === "path" || e.kind === "field" || e.kind === "index" || (e.kind === "unary" && e.op === "*");
}

function verb(op: string): string {
  return ({ "+": "add", "-": "subtract", "*": "multiply", "/": "divide", "%": "calculate the remainder of", "&": "bitand", "|": "bitor", "^": "bitxor" } as Record<string, string>)[op] ?? "apply";
}

function prep(op: string): string {
  return ({ "+": "to", "-": "from", "*": "by", "/": "by", "%": "divided by" } as Record<string, string>)[op] ?? "and";
}

function replaceVars(t: Ty): Ty {
  if (t.k === "var") return ERROR;
  return mapTy(t, replaceVars);
}
