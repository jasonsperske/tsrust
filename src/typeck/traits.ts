/**
 * # Trait selection
 *
 * Whenever the checker needs to know "does `T` implement `Trait`?" — for a
 * bound on a generic call, for `println!("{}", x)`, for `a == b` — it asks the
 * {@link TraitSolver}. The answer is a **selection**: *which* implementation
 * proves it.
 *
 * ```mermaid
 * flowchart TD
 *   Q["Obligation: Vec&lt;i32&gt;: Clone"] --> P{"in the param env?<br/>(a where-clause)"}
 *   P -- yes --> SP[selected: param]
 *   P -- no --> B{"built-in?<br/>(i32: Copy, &T: Clone...)"}
 *   B -- yes --> SB["selected: builtin<br/>(+ nested obligations)"]
 *   B -- no --> D{"#[derive]d?"}
 *   D -- yes --> SD["selected: derived<br/>(each type arg: Clone)"]
 *   D -- no --> I{"try each impl:<br/>unify impl header<br/>with Vec&lt;i32&gt;"}
 *   I --> M["impl&lt;T: Clone&gt; Clone for Vec&lt;T&gt;<br/>T := i32"]
 *   M --> N["nested obligation: i32: Clone"] --> Q2[recurse ↺]
 * ```
 *
 * Matching an impl is just unification: instantiate the impl's generic params
 * with fresh inference variables, unify the impl's self type with ours, then
 * prove the impl's own where-clauses recursively. Each attempt runs inside an
 * inference *snapshot* so a failed candidate leaves no trace.
 *
 * ## Associated types
 *
 * `<Vec<i32> as IntoIterator>::Item` is **normalized** by selecting the impl
 * and reading its `type Item = T;` with `T := i32`. If the self type is still
 * an inference variable we can't know the answer yet; the checker parks the
 * question as a pending obligation and retries once more is known.
 */
import type { DefId } from "../resolve/defs.ts";
import type { InferCtxt } from "./infer.ts";
import type { Predicate, TraitRef, TyCtxt } from "./tcx.ts";
import { mapTy, substitute, type Subst, type Ty } from "./types.ts";

export type Selection =
  /** `pending`: the impl's own where-clauses couldn't be decided yet and must be re-checked. */
  | { kind: "impl"; impl: DefId; subst: Subst; pending?: boolean }
  | { kind: "param" }
  | { kind: "builtin" }
  | { kind: "derived" }
  | { kind: "ambiguous" }
  | { kind: "none" };

const MAX_DEPTH = 24;

/** Traits whose implementations for primitive types are built into the compiler. */
const PRIM_TRAITS: Record<string, (t: Ty) => boolean> = {
  Copy: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "never",
  Clone: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "never",
  Debug: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "str",
  Display: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "str",
  PartialEq: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "str",
  Eq: (t) => t.k === "int" || t.k === "bool" || t.k === "char" || t.k === "str",
  PartialOrd: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char" || t.k === "str",
  Ord: (t) => t.k === "int" || t.k === "bool" || t.k === "char" || t.k === "str",
  Hash: (t) => t.k === "int" || t.k === "bool" || t.k === "char" || t.k === "str",
  Default: (t) => t.k === "int" || t.k === "float" || t.k === "bool" || t.k === "char",
};

/** Traits that tuples (and `()`) implement when all their elements do. */
const STRUCTURAL_TRAITS = new Set(["Copy", "Clone", "Debug", "PartialEq", "Eq", "PartialOrd", "Ord", "Hash", "Default"]);
/** Traits that `&T` implements when `T` does. */
const REF_FORWARDING = new Set(["Debug", "Display", "PartialEq", "Eq", "PartialOrd", "Ord", "Hash"]);
/** `String` is native, so its comparison and formatting traits are too. */
const STRING_TRAITS = new Set(["Debug", "Display", "PartialEq", "Eq", "PartialOrd", "Ord", "Hash"]);

export class TraitSolver {
  private readonly tcx: TyCtxt;
  private readonly infcx: InferCtxt;
  /** Where-clauses in scope, elaborated with supertraits. */
  readonly env: Predicate[];
  private readonly langNames = new Map<DefId, string>();

  constructor(tcx: TyCtxt, infcx: InferCtxt, env: Predicate[]) {
    this.tcx = tcx;
    this.infcx = infcx;
    for (const [name, def] of tcx.res.lang) this.langNames.set(def, name);
    this.env = [];
    for (const p of env) {
      if (p.kind === "proj") { this.env.push(p); continue; }
      for (const tr of this.elaborate({ trait: p.trait, args: p.args }, p.self)) this.env.push({ kind: "trait", self: p.self, trait: tr.trait, args: tr.args });
    }
  }

  /** A trait ref plus its supertraits, with `Self` and trait params substituted. */
  private elaborate(tr: TraitRef, self: Ty): TraitRef[] {
    const out: TraitRef[] = [];
    const seen = new Set<DefId>();
    const go = (t: TraitRef) => {
      if (seen.has(t.trait)) return;
      seen.add(t.trait);
      out.push(t);
      const info = this.tcx.traitInfo(t.trait);
      const params = this.tcx.allParams(t.trait);
      const subst: Subst = new Map([[info.selfParam, self], ...params.slice(1).map((p, i) => [p, t.args[i]] as [DefId, Ty])]);
      for (const s of info.supertraits) go({ trait: s.trait, args: s.args.map((a) => substitute(a, subst)) });
    };
    go(tr);
    return out;
  }

  traitName(trait: DefId): string | undefined {
    return this.langNames.get(trait);
  }

  /**
   * Does `self: trait<args>` hold? On success the inference variables in
   * `self`/`args` may get bound (e.g. selecting `Vec<?0>: Clone` against a
   * unique impl doesn't bind anything, but `?0: From<&str>` might).
   */
  select(self: Ty, trait: DefId, args: Ty[], depth = 0): Selection {
    if (depth > MAX_DEPTH) return { kind: "ambiguous" };
    self = this.infcx.shallow(self);
    if (self.k === "error") return { kind: "builtin" };
    if (self.k === "never") return { kind: "builtin" };

    // 1. Where-clauses in scope.
    for (const p of this.env) {
      if (p.kind !== "trait" || p.trait !== trait) continue;
      const snap = this.infcx.snapshot();
      if (this.infcx.unify(p.self, self) && p.args.every((a, i) => this.infcx.unify(a, args[i]))) return { kind: "param" };
      this.infcx.rollback(snap);
    }

    const name = this.langNames.get(trait);
    if (self.k === "var") {
      // An unsuffixed integer literal implements whatever every integer type does.
      const kind = this.infcx.kindOf(self.id);
      if (name && kind !== "general" && PRIM_TRAITS[name]?.(kind === "int" ? { k: "int", name: "i32" } : { k: "float", name: "f64" })) return { kind: "builtin" };
      return { kind: "ambiguous" };
    }

    // 2. Built-in impls.
    if (name) {
      const builtin = this.builtin(name, self, trait, depth);
      if (builtin) return builtin;
    }

    // 3. #[derive(...)]
    if (self.k === "adt" && this.tcx.derives.get(self.def)?.has(trait)) {
      // A derived impl requires each type argument to implement the trait too.
      let result: Selection = { kind: "derived" };
      for (const a of self.args) {
        const r = this.select(a, trait, args, depth + 1);
        if (r.kind === "none") return r;
        if (r.kind === "ambiguous") result = r;
      }
      return result;
    }

    // 4. User (and std) impls.
    const candidates: { impl: DefId; ambiguous: boolean }[] = [];
    for (const impl of this.tcx.traitImpls.get(trait) ?? []) {
      const snap = this.infcx.snapshot();
      const r = this.matchImpl(impl, self, args, depth);
      this.infcx.rollback(snap);
      if (r !== "none") candidates.push({ impl, ambiguous: r === "ambiguous" });
    }
    if (candidates.length === 0) return { kind: "none" };
    // Several impls fit (e.g. `Range<{integer}>: Iterator` matches the impl for every
    // integer type): we can't choose until inference learns more.
    if (candidates.length > 1) return { kind: "ambiguous" };
    // Exactly one impl fits. Commit to it even if its where-clauses are still
    // undecided (they're returned as `pending` for the caller to re-check):
    // this is what lets `Range<{integer}>::Item` normalize to `{integer}`.
    const chosen = candidates[0];
    const subst = this.instantiate(chosen.impl);
    this.unifyImplHeader(chosen.impl, subst, self, args);
    const nested = this.proveImplPredicates(chosen.impl, subst, depth);
    return { kind: "impl", impl: chosen.impl, subst, pending: nested === "ambiguous" || chosen.ambiguous };
  }

  holds(self: Ty, trait: DefId, args: Ty[] = []): boolean {
    const snap = this.infcx.snapshot();
    const r = this.select(self, trait, args);
    this.infcx.rollback(snap);
    return r.kind !== "none" && r.kind !== "ambiguous";
  }

  /** Fresh inference variables for every generic param of an impl. */
  instantiate(def: DefId): Subst {
    return new Map(this.tcx.allParams(def).map((p) => [p, this.infcx.newVar()]));
  }

  private unifyImplHeader(impl: DefId, subst: Subst, self: Ty, args: Ty[]): boolean {
    const h = this.tcx.implHeader(impl)!;
    if (!this.infcx.unify(substitute(h.selfTy, subst), self)) return false;
    const implArgs = h.trait?.args ?? [];
    return implArgs.every((a, i) => args[i] === undefined || this.infcx.unify(substitute(a, subst), args[i]));
  }

  private matchImpl(impl: DefId, self: Ty, args: Ty[], depth: number): "ok" | "ambiguous" | "none" {
    const subst = this.instantiate(impl);
    if (!this.unifyImplHeader(impl, subst, self, args)) return "none";
    return this.proveImplPredicates(impl, subst, depth);
  }

  private proveImplPredicates(impl: DefId, subst: Subst, depth: number): "ok" | "ambiguous" | "none" {
    let result: "ok" | "ambiguous" = "ok";
    for (const p of this.tcx.predicates(impl)) {
      if (p.kind === "trait") {
        const r = this.select(substitute(p.self, subst), p.trait, p.args.map((a) => substitute(a, subst)), depth + 1);
        if (r.kind === "none") return "none";
        if (r.kind === "ambiguous") result = "ambiguous";
      } else {
        const proj: Ty = { k: "proj", trait: p.trait, traitArgs: p.traitArgs.map((a) => substitute(a, subst)), self: substitute(p.self, subst), name: p.name };
        const n = this.normalize(proj, depth + 1);
        if (n === undefined) result = "ambiguous";
        else if (!this.infcx.unify(n, substitute(p.ty, subst))) return "none";
      }
    }
    return result;
  }

  private builtin(name: string, self: Ty, trait: DefId, depth: number): Selection | undefined {
    if (PRIM_TRAITS[name]?.(self)) return { kind: "builtin" };
    if (self.k === "tuple" && STRUCTURAL_TRAITS.has(name)) return this.all(self.elems, trait, depth);
    if (self.k === "ref") {
      if (!self.mutable && (name === "Copy" || name === "Clone")) return { kind: "builtin" };
      if (REF_FORWARDING.has(name)) return this.all([self.inner], trait, depth);
    }
    if (self.k === "adt") {
      if (this.tcx.isLang(self.def, "String") && STRING_TRAITS.has(name)) return { kind: "builtin" };
      if (this.tcx.isLang(self.def, "Box") && ["Debug", "PartialEq", "Eq", "PartialOrd", "Ord"].includes(name)) return this.all(self.args, trait, depth);
    }
    return undefined;
  }

  private all(tys: Ty[], trait: DefId, depth: number): Selection {
    let result: Selection = { kind: "builtin" };
    for (const t of tys) {
      const r = this.select(t, trait, [], depth + 1);
      if (r.kind === "none") return r;
      if (r.kind === "ambiguous") result = r;
    }
    return result;
  }

  /**
   * Normalize a projection like `<Vec<i32> as IntoIterator>::Item`.
   * Returns `undefined` when it can't be decided yet (the self type is unknown).
   */
  normalize(t: Extract<Ty, { k: "proj" }>, depth = 0): Ty | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const self = this.infcx.shallow(t.self);
    // A binding from the environment (`I: Iterator<Item = u8>`) wins.
    for (const p of this.env) {
      if (p.kind !== "proj" || p.trait !== t.trait || p.name !== t.name) continue;
      const snap = this.infcx.snapshot();
      if (this.infcx.unify(p.self, self) && p.traitArgs.every((a, i) => this.infcx.unify(a, t.traitArgs[i]))) return p.ty;
      this.infcx.rollback(snap);
    }
    if (self.k === "var") return undefined;
    const sel = this.select(self, t.trait, t.traitArgs, depth);
    // A generic param proven by a where-clause stays a *rigid* projection: `I::Item` is
    // an opaque type inside the function. But a blanket impl can still normalize it.
    if (sel.kind !== "impl" && (self.k === "param" || self.k === "proj")) return { ...t, self };
    if (sel.kind === "impl") {
      const raw = this.tcx.implAssocType(sel.impl, t.name);
      if (!raw) return undefined;
      return this.normalizeDeep(substitute(raw, sel.subst), () => undefined, depth + 1);
    }
    return undefined;
  }

  /**
   * Normalize every projection inside `t`. Projections that can't be
   * normalized yet are handed to `onStuck`, which usually replaces them with a
   * fresh inference variable and records a pending obligation.
   */
  normalizeDeep(t: Ty, onStuck: (p: Extract<Ty, { k: "proj" }>) => Ty | undefined, depth = 0): Ty {
    const go = (t: Ty): Ty => {
      t = this.infcx.shallow(t);
      if (t.k === "proj") {
        const inner = { ...t, self: go(t.self), traitArgs: t.traitArgs.map(go) };
        const n = this.normalize(inner, depth);
        if (n !== undefined) return n.k === "proj" ? n : go(n);
        return onStuck(inner) ?? inner;
      }
      return mapTy(t, go);
    };
    return go(t);
  }
}
