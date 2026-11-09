/**
 * # Type inference by unification
 *
 * In `let mut v = Vec::new(); v.push(1u8);` nobody wrote `v`'s type. The
 * checker gives it a placeholder **inference variable** `Vec<?0>`, and later
 * learns `?0 = u8` from the `push` call. This is the heart of
 * Hindley–Milner-style inference:
 *
 * 1. Unknown types become fresh variables `?0, ?1, ...`.
 * 2. Every place two types must agree, we **unify** them: walk both types in
 *    parallel; when one side is a variable, record what it equals.
 * 3. At the end, replace every variable with what it was bound to.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant C as checker
 *   participant I as InferCtxt
 *   C->>I: newVar() → ?0          (Vec::new() : Vec<?0>)
 *   C->>I: unify(?0, u8)          (v.push(1u8))
 *   I-->>C: ok, ?0 := u8
 *   C->>I: resolve(Vec<?0>)
 *   I-->>C: Vec<u8>
 * ```
 *
 * Integer literals get a special *integral* variable: it may only unify with
 * integer types, and defaults to `i32` if nothing else constrains it — that's
 * why `let x = 5;` is an `i32`. Float literals default to `f64`.
 *
 * Method lookup sometimes needs to *try* a unification and undo it if the
 * candidate doesn't fit; {@link InferCtxt.snapshot} and {@link InferCtxt.rollback}
 * support that with an undo log.
 */
import { mapTy, type Ty } from "./types.ts";

export type VarKind = "general" | "int" | "float";

export class InferCtxt {
  private readonly bindings: (Ty | undefined)[] = [];
  private readonly kinds: VarKind[] = [];
  private readonly undo: { id: number; binding: Ty | undefined; kind: VarKind }[] = [];
  /** Variables that were unified with `!` (for never-type fallback). */
  private readonly sawNever = new Set<number>();

  newVar(kind: VarKind = "general"): Ty {
    this.bindings.push(undefined);
    this.kinds.push(kind);
    return { k: "var", id: this.bindings.length - 1 };
  }

  kindOf(id: number): VarKind {
    return this.kinds[id];
  }

  /** Follow variable bindings until reaching a non-variable or an unbound variable. */
  shallow(t: Ty): Ty {
    while (t.k === "var") {
      const b = this.bindings[t.id];
      if (!b) return t;
      t = b;
    }
    return t;
  }

  /** Replace every bound variable inside `t`, recursively. */
  resolve(t: Ty): Ty {
    t = this.shallow(t);
    if (t.k === "var") return t;
    return mapTy(t, (x) => this.resolve(x));
  }

  snapshot(): number {
    return this.undo.length;
  }

  rollback(snap: number) {
    while (this.undo.length > snap) {
      const u = this.undo.pop()!;
      this.bindings[u.id] = u.binding;
      this.kinds[u.id] = u.kind;
    }
  }

  private bind(id: number, t: Ty) {
    this.undo.push({ id, binding: this.bindings[id], kind: this.kinds[id] });
    this.bindings[id] = t;
  }

  private setKind(id: number, kind: VarKind) {
    this.undo.push({ id, binding: this.bindings[id], kind: this.kinds[id] });
    this.kinds[id] = kind;
  }

  /** Does variable `id` occur inside `t`? Binding `?0 := Vec<?0>` would create an infinite type. */
  private occurs(id: number, t: Ty): boolean {
    t = this.shallow(t);
    if (t.k === "var") return t.id === id;
    let found = false;
    mapTy(t, (x) => {
      if (!found && this.occurs(id, x)) found = true;
      return x;
    });
    return found;
  }

  /** Make `a` and `b` the same type, binding variables as needed. Returns false on mismatch. */
  unify(a: Ty, b: Ty): boolean {
    a = this.shallow(a);
    b = this.shallow(b);
    if (a.k === "error" || b.k === "error") return true;
    if (a.k === "var" && b.k === "var") {
      if (a.id === b.id) return true;
      // Keep the more specific kind: binding a general var to an int var keeps "int".
      if (this.kinds[a.id] === "general") { this.bind(a.id, b); return true; }
      if (this.kinds[b.id] === "general") { this.bind(b.id, a); return true; }
      if (this.kinds[a.id] !== this.kinds[b.id]) return false;
      this.bind(a.id, b);
      return true;
    }
    if (a.k === "var") return this.bindVar(a.id, b);
    if (b.k === "var") return this.bindVar(b.id, a);
    if (a.k === "never" || b.k === "never") return true;
    if (a.k !== b.k) return false;
    switch (a.k) {
      case "int": case "float": return a.name === (b as typeof a).name;
      case "bool": case "char": case "str": return true;
      case "tuple": {
        const bb = b as typeof a;
        return a.elems.length === bb.elems.length && a.elems.every((e, i) => this.unify(e, bb.elems[i]));
      }
      case "ref": {
        const bb = b as typeof a;
        return a.mutable === bb.mutable && this.unify(a.inner, bb.inner);
      }
      case "adt": {
        const bb = b as typeof a;
        return a.def === bb.def && a.args.length === bb.args.length && a.args.every((e, i) => this.unify(e, bb.args[i]));
      }
      case "param": return a.def === (b as typeof a).def;
      case "proj": {
        const bb = b as typeof a;
        return a.trait === bb.trait && a.name === bb.name && this.unify(a.self, bb.self) && a.traitArgs.every((e, i) => this.unify(e, bb.traitArgs[i]));
      }
    }
    return false;
  }

  private bindVar(id: number, t: Ty): boolean {
    if (t.k === "never") {
      // Don't commit to `!`: the variable may still learn a real type from
      // another branch. Remember it for fallback.
      this.sawNever.add(id);
      return true;
    }
    const kind = this.kinds[id];
    if (kind === "int" && t.k !== "int") return false;
    if (kind === "float" && t.k !== "float") return false;
    if (this.occurs(id, t)) return false;
    this.bind(id, t);
    return true;
  }

  /** Is `t` an integral/float inference variable (an unsuffixed literal)? */
  isNumericVar(t: Ty): VarKind | undefined {
    t = this.shallow(t);
    return t.k === "var" && this.kinds[t.id] !== "general" ? this.kinds[t.id] : undefined;
  }

  /** Narrow a general variable to integral (used when we learn it must be an integer). */
  constrainKind(t: Ty, kind: VarKind) {
    t = this.shallow(t);
    if (t.k === "var" && this.kinds[t.id] === "general") this.setKind(t.id, kind);
  }

  /**
   * Apply defaults to everything still unknown: integer literals become
   * `i32`, float literals `f64`, and variables only ever unified with `!`
   * become `()` ("never type fallback").
   */
  applyDefaults() {
    for (let id = 0; id < this.bindings.length; id++) {
      if (this.bindings[id]) continue;
      const root = this.shallow({ k: "var", id });
      if (root.k !== "var" || root.id !== id) continue;
      if (this.kinds[id] === "int") this.bind(id, { k: "int", name: "i32" });
      else if (this.kinds[id] === "float") this.bind(id, { k: "float", name: "f64" });
      else if (this.sawNever.has(id)) this.bind(id, { k: "tuple", elems: [] });
    }
  }
}
