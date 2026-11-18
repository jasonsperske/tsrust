/**
 * # Exhaustiveness checking
 *
 * Rust refuses to compile a `match` that doesn't handle every possible value:
 *
 * ```text
 * error[E0004]: non-exhaustive patterns: `None` not covered
 * ```
 *
 * The algorithm (from Luc Maranget, "Warnings for pattern matching", and used
 * by rustc) is built on one question, **usefulness**: given the arms so far
 * (a *matrix* of patterns, one row per arm), is there a value that a new
 * pattern row `v` matches but no existing row does?
 *
 * - The `match` is exhaustive iff the wildcard row `_` is **not** useful after
 *   all the arms. If it is useful, the value it finds is the *witness* we
 *   print: `None not covered`.
 * - An arm is unreachable iff its row is **not** useful against the arms
 *   above it.
 *
 * Usefulness is computed by *specializing* the matrix on constructors:
 *
 * ```mermaid
 * flowchart TD
 *   M["rows: Some(true), None"] -->|"wildcard v = _: try each ctor of Option"| S1["specialize on Some:<br/>rows: true"]
 *   M --> S2["specialize on None:<br/>rows: (empty tuple)"]
 *   S1 -->|"try each ctor of bool"| B1["true: covered"]
 *   S1 --> B2["false: NOT covered → witness Some(false)"]
 * ```
 *
 * Types with infinitely many values (integers, strings) have no finite list
 * of constructors; for them only a wildcard (or binding) covers "the rest".
 *
 * ## Empty types
 *
 * A type with no values, such as `!`, `enum Void {}`, `(i32, !)` or a struct
 * with a `!` field, has no constructors to cover, so `let Ok(v) = r;` is
 * irrefutable for `r: Result<T, !>`. The exception is data behind a reference:
 * unsafe code could have produced a `&!`, so those cases must still be written.
 */
import type { Diagnostics } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";
import type { TypeckResults } from "./results.ts";
import type { TyCtxt } from "./tcx.ts";
import { substitute, type Ty } from "./types.ts";

type Ctor =
  | { kind: "variant"; index: number }
  | { kind: "single" } // structs, tuples, references
  | { kind: "bool"; value: boolean }
  | { kind: "range"; lo: number; hi: number } // ints and chars (as code points)
  | { kind: "str"; value: string }
  /** A sequence: exactly `prefix` elements, or with `varlen`, `prefix` + any number + `suffix`. */
  | { kind: "slice"; prefix: number; suffix: number; varlen: boolean }
  | { kind: "opaque" }; // matches nothing we can reason about (floats, consts)

/** `behindRef`: reached through a reference, so empty types can't be assumed empty. */
type DPat = ({ kind: "wild"; ty: Ty } | { kind: "ctor"; ctor: Ctor; fields: DPat[]; ty: Ty } | { kind: "or"; alts: DPat[]; ty: Ty }) & { behindRef?: boolean };

/** `..` or `name @ ..` inside a slice pattern. */
export function isRestPat(p: A.Pattern): boolean {
  return p.kind === "rest" || (p.kind === "ident" && p.sub?.kind === "rest");
}

export class ExhaustivenessChecker {
  private readonly tcx: TyCtxt;
  private readonly r: TypeckResults;
  private readonly diags: Diagnostics;
  /** The function being checked: private fields are only known to be empty from inside their module. */
  private body: number | undefined;

  constructor(tcx: TyCtxt, r: TypeckResults, diags: Diagnostics) {
    this.tcx = tcx;
    this.r = r;
    this.diags = diags;
  }

  enterBody(def: number) {
    this.body = def;
  }

  /** Check a `match` expression: exhaustive arms, and no unreachable ones. */
  checkMatch(e: Extract<A.Expr, { kind: "match" }>) {
    const ty = this.r.types.get(e.scrutinee.id);
    if (!ty || this.hasError(ty)) return;
    const rows: DPat[][] = [];
    for (const arm of e.arms) {
      const row = [this.lower(arm.pat, ty)];
      if (e.source === "match" && !this.useful(rows, row)) {
        this.diags.warning("typeck", arm.pat.span, "unreachable pattern").note("this arm can never match: earlier arms cover every value it matches");
      }
      if (!arm.guard) rows.push(row);
    }
    const witness = this.useful(rows, [{ kind: "wild", ty }]);
    if (witness) {
      const shown = this.show(witness[0]);
      const b = this.diags.error("typeck", e.scrutinee.span, `non-exhaustive patterns: \`${shown}\` not covered`, "E0004");
      b.diag.labels[0].message = `pattern \`${shown}\` not covered`;
      b.note(`the matched value is of type \`${this.tcx.show(ty)}\``);
      b.help(`ensure that all possible cases are being handled by adding a match arm with a wildcard pattern or an explicit pattern \`${shown} => todo!()\``);
    }
  }

  /** `let`, `for` and function parameters need irrefutable patterns (E0005). */
  checkIrrefutable(p: A.Pattern, ty: Ty | undefined, what: string) {
    if (!ty || this.hasError(ty)) return;
    const witness = this.useful([[this.lower(p, ty)]], [{ kind: "wild", ty }]);
    if (witness) {
      const shown = this.show(witness[0]);
      this.diags.error("typeck", p.span, `refutable pattern in ${what}: \`${shown}\` not covered`, "E0005")
        .note(`\`let\` bindings require an "irrefutable pattern", one that matches every possible value`)
        .help("use `if let` or `match` to handle the other cases");
    }
  }

  private hasError(t: Ty): boolean {
    return JSON.stringify(t).includes('"error"');
  }

  // -------------------------------------------------------------------------
  // Lowering AST patterns into constructor form
  // -------------------------------------------------------------------------

  private lower(p: A.Pattern, outerTy: Ty): DPat {
    const derefs = this.r.patDerefs.get(p.id) ?? 0;
    // Re-wrap match-ergonomics derefs as explicit reference patterns.
    const peel = (t: Ty, n: number): Ty[] => {
      const out = [t];
      for (let i = 0; i < n; i++) {
        const cur = out[out.length - 1];
        out.push(cur.k === "ref" ? cur.inner : cur);
      }
      return out;
    };
    const chain = peel(outerTy, derefs);
    let inner = this.lowerInner(p, chain[chain.length - 1]);
    for (let i = derefs - 1; i >= 0; i--) inner = { kind: "ctor", ctor: { kind: "single" }, fields: [inner], ty: chain[i] };
    return inner;
  }

  private lowerInner(p: A.Pattern, ty: Ty): DPat {
    const wild: DPat = { kind: "wild", ty };
    switch (p.kind) {
      case "wild": return wild;
      case "ident": {
        if (this.tcx.res.patternPaths.has(p.id)) return this.lowerCtorRef(p, ty, []);
        return p.sub ? this.lower(p.sub, ty) : wild;
      }
      case "lit": return { kind: "ctor", ctor: this.litCtor(p.value), fields: [], ty };
      case "range": {
        const lo = this.litNum(p.lo), hi = this.litNum(p.hi);
        if (lo === undefined || hi === undefined) return { kind: "ctor", ctor: { kind: "opaque" }, fields: [], ty };
        return { kind: "ctor", ctor: { kind: "range", lo, hi: p.inclusive ? hi : hi - 1 }, fields: [], ty };
      }
      case "tuple": {
        const elems = ty.k === "tuple" ? ty.elems : p.elems.map(() => ty);
        return { kind: "ctor", ctor: { kind: "single" }, fields: p.elems.map((x, i) => this.lower(x, elems[i])), ty };
      }
      case "ref": return { kind: "ctor", ctor: { kind: "single" }, fields: [this.lower(p.inner, ty.k === "ref" ? ty.inner : ty)], ty };
      case "or": return { kind: "or", alts: p.alts.map((a) => this.lower(a, ty)), ty };
      case "rest": return wild;
      case "slice": {
        const elem = ty.k === "array" ? ty.elem : ty.k === "slice" ? ty.elem : ty;
        const at = p.elems.findIndex(isRestPat);
        const low = (xs: A.Pattern[]) => xs.map((x) => this.lower(x, elem));
        if (at < 0) return { kind: "ctor", ctor: { kind: "slice", prefix: p.elems.length, suffix: 0, varlen: false }, fields: low(p.elems), ty };
        const before = low(p.elems.slice(0, at)), after = low(p.elems.slice(at + 1));
        if (ty.k === "array" && ty.len.k === "constval") {
          // An array's length is known, so `..` just stands for wildcards.
          const middle = Array.from({ length: Math.max(0, ty.len.n - before.length - after.length) }, (): DPat => ({ kind: "wild", ty: elem }));
          return { kind: "ctor", ctor: { kind: "slice", prefix: ty.len.n, suffix: 0, varlen: false }, fields: [...before, ...middle, ...after], ty };
        }
        return { kind: "ctor", ctor: { kind: "slice", prefix: before.length, suffix: after.length, varlen: true }, fields: [...before, ...after], ty };
      }
      case "path": return this.lowerCtorRef(p, ty, []);
      case "tupleStruct": return this.lowerCtorRef(p, ty, p.elems.map((x, i) => ({ index: i, pat: x })));
      case "struct": return this.lowerCtorRef(p, ty, p.fields.map((f) => ({ index: this.r.fieldIndices.get(f.pat.id) ?? -1, pat: f.pat })));
    }
  }

  private lowerCtorRef(p: A.Pattern, ty: Ty, sub: { index: number; pat: A.Pattern }[]): DPat {
    const c = this.r.ctors.get(p.id);
    if (!c) return { kind: "ctor", ctor: { kind: "opaque" }, fields: [], ty }; // a constant
    const fieldTys = this.fieldTys(ty, c.def);
    const fields: DPat[] = fieldTys.map((t) => ({ kind: "wild", ty: t }));
    for (const s of sub) if (s.index >= 0 && s.index < fields.length) fields[s.index] = this.lower(s.pat, fieldTys[s.index]);
    const d = this.tcx.defs[c.def];
    const ctor: Ctor = d.kind === "variant" ? { kind: "variant", index: d.variantIndex! } : { kind: "single" };
    return { kind: "ctor", ctor, fields, ty };
  }

  private litCtor(l: A.Literal): Ctor {
    switch (l.kind) {
      case "bool": return { kind: "bool", value: l.value };
      case "int": return { kind: "range", lo: l.value, hi: l.value };
      case "char": return { kind: "range", lo: l.value.codePointAt(0)!, hi: l.value.codePointAt(0)! };
      case "str": return { kind: "str", value: l.value };
      case "float": return { kind: "opaque" };
    }
  }

  private litNum(l: A.Literal): number | undefined {
    if (l.kind === "int") return l.value;
    if (l.kind === "char") return l.value.codePointAt(0);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Constructors of a type
  // -------------------------------------------------------------------------

  /** All constructors of `ty`, or `undefined` if there are infinitely many. */
  private allCtors(ty: Ty, behindRef = false): Ctor[] | undefined {
    if (!behindRef && !this.inhabited(ty)) return [];
    switch (ty.k) {
      case "bool": return [{ kind: "bool", value: false }, { kind: "bool", value: true }];
      case "tuple": case "ref": return [{ kind: "single" }];
      case "array": return ty.len.k === "constval" ? [{ kind: "slice", prefix: ty.len.n, suffix: 0, varlen: false }] : [{ kind: "slice", prefix: 0, suffix: 0, varlen: true }];
      case "adt": {
        if (this.tcx.isNativeAdt(ty.def)) return undefined;
        const d = this.tcx.defs[ty.def];
        if (d.kind === "struct") return [{ kind: "single" }];
        const all = this.tcx.variants(ty.def).map((v, i) => ({ v, ctor: { kind: "variant", index: i } as Ctor }));
        // An empty enum behind a reference still needs a `_` arm.
        if (behindRef) return all.length ? all.map((x) => x.ctor) : undefined;
        return all.filter(({ v }) => this.fieldTys(ty, v.def).every((t) => this.inhabited(t))).map((x) => x.ctor);
      }
      default: return undefined;
    }
  }

  /** Could a value of `ty` exist? References and library types always count as inhabited. */
  private inhabited(ty: Ty, seen: string[] = []): boolean {
    if (ty.k === "never") return false;
    if (ty.k === "tuple") return ty.elems.every((t) => this.inhabited(t, seen));
    if (ty.k !== "adt" || this.tcx.isNativeAdt(ty.def)) return true;
    const key = JSON.stringify(ty);
    if (seen.includes(key)) return true;
    const next = [...seen, key];
    const isStruct = this.tcx.defs[ty.def].kind === "struct";
    const variants = this.tcx.variants(ty.def);
    if (isStruct && !this.privateFieldsVisible(ty.def)) {
      const tys = this.fieldTys(ty, variants[0].def);
      return variants[0].fields.every((f, i) => !f.isPub || this.inhabited(tys[i], next));
    }
    return variants.some((v) => this.fieldTys(ty, v.def).every((t) => this.inhabited(t, next)));
  }

  private privateFieldsVisible(def: number): boolean {
    const owner = this.tcx.defs[def].module;
    let m: number | undefined = this.body === undefined ? undefined : this.tcx.defs[this.body].module;
    for (; m !== undefined; m = this.tcx.defs[m].parent) if (m === owner) return true;
    return false;
  }

  /** The same pattern, seen through a reference. */
  private behind(p: DPat): DPat {
    if (p.kind === "ctor") return { ...p, behindRef: true, fields: p.fields.map((f) => this.behind(f)) };
    if (p.kind === "or") return { ...p, behindRef: true, alts: p.alts.map((a) => this.behind(a)) };
    return { ...p, behindRef: true };
  }

  /** The lengths worth distinguishing for a slice, given the patterns in this column. */
  private sliceCtors(present: Ctor[]): Ctor[] {
    let prefix = 0, suffix = 0, fixed = -1;
    for (const c of present) {
      if (c.kind !== "slice") continue;
      if (c.varlen) { prefix = Math.max(prefix, c.prefix); suffix = Math.max(suffix, c.suffix); }
      else fixed = Math.max(fixed, c.prefix);
    }
    if (fixed + 1 > prefix + suffix) prefix = fixed + 1 - suffix;
    const out: Ctor[] = [];
    for (let n = 0; n < prefix + suffix; n++) out.push({ kind: "slice", prefix: n, suffix: 0, varlen: false });
    out.push({ kind: "slice", prefix, suffix, varlen: true });
    return out;
  }

  private fieldTys(ty: Ty, variantDef?: number, ctor?: Ctor): Ty[] {
    if ((ty.k === "array" || ty.k === "slice") && ctor?.kind === "slice") return Array.from({ length: ctor.prefix + ctor.suffix }, () => ty.elem);
    if (ty.k === "tuple") return ty.elems;
    if (ty.k === "ref") return [ty.inner];
    if (ty.k === "adt" && !this.tcx.isNativeAdt(ty.def)) {
      const variants = this.tcx.variants(ty.def);
      const v = variantDef !== undefined ? variants.find((x) => x.def === variantDef) : ctor?.kind === "variant" ? variants[ctor.index] : variants[0];
      if (!v) return [];
      const subst = new Map((this.tcx.res.genericsOf.get(ty.def) ?? []).map((p, i) => [p, ty.args[i]]));
      return v.fields.map((f) => substitute(f.ty, subst));
    }
    return [];
  }

  private sameCtor(a: Ctor, b: Ctor): boolean {
    if (a.kind !== b.kind) return false;
    switch (a.kind) {
      case "variant": return a.index === (b as typeof a).index;
      case "bool": return a.value === (b as typeof a).value;
      case "range": return a.lo === (b as typeof a).lo && a.hi === (b as typeof a).hi;
      case "str": return a.value === (b as typeof a).value;
      case "slice": return a.prefix === (b as typeof a).prefix && a.suffix === (b as typeof a).suffix && a.varlen === (b as typeof a).varlen;
      case "single": return true;
      case "opaque": return false;
    }
  }

  /** Does a row whose head is `rowCtor` match every value of `c`? */
  private covers(rowCtor: Ctor, c: Ctor): boolean {
    if (rowCtor.kind === "range" && c.kind === "range") return rowCtor.lo <= c.lo && c.hi <= rowCtor.hi;
    if (rowCtor.kind === "slice" && c.kind === "slice") {
      if (!rowCtor.varlen) return !c.varlen && rowCtor.prefix === c.prefix;
      return c.prefix + c.suffix >= rowCtor.prefix + rowCtor.suffix;
    }
    return this.sameCtor(rowCtor, c);
  }

  // -------------------------------------------------------------------------
  // The usefulness algorithm
  // -------------------------------------------------------------------------

  /** Expand or-patterns in the first column into separate rows. */
  private expandOr(rows: DPat[][]): DPat[][] {
    const out: DPat[][] = [];
    for (const row of rows) {
      if (row.length && row[0].kind === "or") {
        for (const alt of row[0].alts) out.push(...this.expandOr([[alt, ...row.slice(1)]]));
      } else out.push(row);
    }
    return out;
  }

  /** Keep rows that could match ctor `c`, replacing their head with its fields. */
  private specialize(rows: DPat[][], c: Ctor, arity: number, fieldTys: Ty[]): DPat[][] {
    const out: DPat[][] = [];
    for (const row of rows) {
      const head = row[0];
      if (head.kind === "wild") out.push([...fieldTys.slice(0, arity).map((t): DPat => ({ kind: "wild", ty: t })), ...row.slice(1)]);
      else if (head.kind === "ctor" && this.covers(head.ctor, c)) {
        let fields = head.fields;
        if (head.ctor.kind === "slice" && head.ctor.varlen) {
          // Line a `[a, .., z]` row up with this length: wildcards fill the middle.
          const { prefix, suffix } = head.ctor;
          const middle = fieldTys.slice(prefix, arity - suffix).map((t): DPat => ({ kind: "wild", ty: t }));
          fields = [...fields.slice(0, prefix), ...middle, ...fields.slice(prefix)];
        }
        out.push([...fields, ...row.slice(1)]);
      }
    }
    return out;
  }

  /** Returns a witness row (values not matched by `rows` but matched by `v`), or undefined. */
  useful(rows: DPat[][], v: DPat[]): DPat[] | undefined {
    if (v.length === 0) return rows.length === 0 ? [] : undefined;
    rows = this.expandOr(rows);
    const head = v[0];
    if (head.kind === "or") {
      for (const alt of head.alts) {
        const w = this.useful(rows, [alt, ...v.slice(1)]);
        if (w) return w;
      }
      return undefined;
    }
    const ty = head.ty;
    if (head.kind === "ctor") {
      if (head.ctor.kind === "opaque") {
        // We can't reason about it; treat as useful unless a wildcard row precedes it.
        const hasWild = rows.some((r) => r[0].kind === "wild");
        if (hasWild) {
          const rest = this.useful(rows.filter((r) => r[0].kind === "wild").map((r) => r.slice(1)), v.slice(1));
          return rest ? [head, ...rest] : undefined;
        }
        return [head, ...v.slice(1)];
      }
      const ftys = this.fieldTys(ty, undefined, head.ctor);
      const subs = head.behindRef || ty.k === "ref" ? head.fields.map((f) => this.behind(f)) : head.fields;
      const w = this.useful(this.specialize(rows, head.ctor, head.fields.length, ftys), [...subs, ...v.slice(1)]);
      if (!w) return undefined;
      return [{ kind: "ctor", ctor: head.ctor, fields: w.slice(0, head.fields.length), ty }, ...w.slice(head.fields.length)];
    }
    // Wildcard: is every constructor of the type present in the first column?
    const present = rows.flatMap((r) => (r[0].kind === "ctor" ? [r[0].ctor] : []));
    const all = ty.k === "slice" ? this.sliceCtors(present) : this.allCtors(ty, head.behindRef);
    const behindRef = head.behindRef || ty.k === "ref";
    const complete = all !== undefined && all.every((c) => present.some((p) => this.covers(p, c)));
    if (all !== undefined && complete) {
      for (const c of all) {
        const ftys = this.fieldTys(ty, undefined, c);
        const w = this.useful(this.specialize(rows, c, ftys.length, ftys), [...ftys.map((t): DPat => ({ kind: "wild", ty: t, behindRef })), ...v.slice(1)]);
        if (w) return [{ kind: "ctor", ctor: c, fields: w.slice(0, ftys.length), ty }, ...w.slice(ftys.length)];
      }
      return undefined;
    }
    // Some constructor is missing: only rows starting with a wildcard can help.
    const defaults = rows.filter((r) => r[0].kind === "wild").map((r) => r.slice(1));
    const w = this.useful(defaults, v.slice(1));
    if (!w) return undefined;
    let witness: DPat = { kind: "wild", ty };
    if (all !== undefined && present.length > 0) {
      const missing = all.find((c) => !present.some((p) => this.covers(p, c)));
      if (missing) {
        const ftys = this.fieldTys(ty, undefined, missing);
        witness = { kind: "ctor", ctor: missing, fields: ftys.map((t) => ({ kind: "wild", ty: t })), ty };
      }
    }
    return [witness, ...w];
  }

  // -------------------------------------------------------------------------
  // Printing witnesses
  // -------------------------------------------------------------------------

  private show(p: DPat): string {
    if (p.kind === "wild") return "_";
    if (p.kind === "or") return p.alts.map((a) => this.show(a)).join(" | ");
    const ty = p.ty;
    switch (p.ctor.kind) {
      case "bool": return String(p.ctor.value);
      case "range": return p.ctor.lo === p.ctor.hi ? String(p.ctor.lo) : `${p.ctor.lo}..=${p.ctor.hi}`;
      case "str": return JSON.stringify(p.ctor.value);
      case "opaque": return "_";
      case "slice": {
        const shown = p.fields.map((f) => this.show(f));
        if (p.ctor.varlen) shown.splice(p.ctor.prefix, 0, "..");
        return `[${shown.join(", ")}]`;
      }
      case "single":
        if (ty.k === "tuple") return `(${p.fields.map((f) => this.show(f)).join(", ")})`;
        if (ty.k === "ref") return `&${this.show(p.fields[0])}`;
        if (ty.k === "adt") return this.showVariant(this.tcx.variants(ty.def)[0], p.fields, false);
        return "_";
      case "variant": {
        if (ty.k !== "adt") return "_";
        const v = this.tcx.variants(ty.def)[p.ctor.index];
        const enumName = this.tcx.defs[ty.def].name;
        const prelude = ["Option", "Result"].includes(enumName) && this.tcx.defs[ty.def].crate === this.tcx.defs[this.tcx.lang("Option")].crate;
        return this.showVariant(v, p.fields, !prelude, enumName);
      }
    }
  }

  private showVariant(v: { name: string; fieldsKind: A.FieldsKind; fields: { name: string }[] }, fields: DPat[], qualify: boolean, enumName?: string): string {
    const name = qualify && enumName ? `${enumName}::${v.name}` : v.name;
    if (v.fieldsKind === "unit") return name;
    if (v.fieldsKind === "tuple") return `${name}(${fields.map((f) => this.show(f)).join(", ")})`;
    const shown = fields.map((f, i) => [v.fields[i].name, this.show(f)] as const).filter(([, s]) => s !== "_");
    return shown.length ? `${name} { ${shown.map(([n, s]) => `${n}: ${s}`).join(", ")}, .. }` : `${name} { .. }`;
  }
}
