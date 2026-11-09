/**
 * # MIR: the borrow checker's view of a function
 *
 * Checking ownership directly on the tree-shaped AST is awkward: borrows
 * flow through `if`s, loops and early `return`s. So, like rustc, we first
 * **lower** each function body into a *control-flow graph* (CFG) of simple
 * statements over **places**, called MIR (Mid-level IR).
 *
 * ```rust
 * fn f(v: &mut Vec<i32>, c: bool) -> usize {
 *     let n = v.len();
 *     if c { v.push(1); }
 *     n
 * }
 * ```
 *
 * becomes roughly:
 *
 * ```mermaid
 * flowchart TD
 *   bb0["bb0<br/>_4 = &(*_1)<br/>_3 = call len(move _4)<br/>switch(_2)"]
 *   bb1["bb1<br/>_6 = &mut (*_1)<br/>_5 = call push(move _6, const)"]
 *   bb2["bb2<br/>_0 = copy _3<br/>return"]
 *   bb0 -->|true| bb1 --> bb2
 *   bb0 -->|false| bb2
 * ```
 *
 * - A **local** (`_0`, `_1` ...) is a variable or a compiler temporary.
 *   `_0` holds the return value; `_1.._n` are the arguments.
 * - A **place** is a local plus a path of *projections*: `(*_1).field[_]`.
 *   Places are what you can borrow, move from and assign to.
 * - An **operand** reads a place by `copy` (for `Copy` types) or by `move`.
 * - Each `&` creates a numbered **loan**: a record of which place was borrowed,
 *   how (shared or mutable), and where.
 *
 * Statements only ever touch places, so the borrow checker's rules become
 * questions about places: "is any loan of an overlapping place still alive?"
 */
import type { Span } from "../diagnostics.ts";
import type { Ty } from "../typeck/types.ts";

export type Local = number;

export interface LocalDecl {
  name?: string;
  ty: Ty;
  mutable: boolean;
  span: Span;
  kind: "return" | "arg" | "user" | "temp";
}

export type Projection =
  | { k: "deref"; via: "ref" | "refMut" | "box" | "other" }
  | { k: "field"; index: number; variant?: number; name?: string }
  | { k: "index" };

export interface Place {
  local: Local;
  proj: Projection[];
}

/** `refs` marks values whose type may contain a reference (so reading them can carry a loan). */
export type Operand =
  | { k: "copy"; place: Place; refs?: boolean }
  | { k: "move"; place: Place; refs?: boolean }
  | { k: "const" };

/** How a call's result may borrow from each argument (see `signature.ts`). */
export type ArgFlow = "none" | "inner" | "full";

export type Rvalue =
  | { k: "use"; op: Operand }
  | { k: "ref"; mutable: boolean; place: Place; loan: number }
  | { k: "aggregate"; ops: Operand[] }
  | { k: "call"; ops: Operand[]; flows: ArgFlow[]; name: string }
  /** Arithmetic, comparisons, casts: the result never holds a borrow. */
  | { k: "pure"; ops: Operand[] };

export type Statement =
  | { k: "assign"; dest: Place; rv: Rvalue; span: Span }
  /** Read a place without moving it (e.g. the scrutinee of a `match`). */
  | { k: "inspect"; place: Place; span: Span }
  /** End of a variable's scope: its storage is freed. */
  | { k: "dead"; local: Local; span: Span };

export type Terminator =
  | { k: "goto"; target: number }
  | { k: "switch"; targets: number[] }
  | { k: "return"; span: Span }
  | { k: "unreachable" };

export interface BasicBlock {
  stmts: Statement[];
  term: Terminator;
}

export interface Loan {
  id: number;
  place: Place;
  mutable: boolean;
  span: Span;
  /** True for borrows the compiler inserted for a method receiver (`v.push(..)` borrows `v`). */
  implicit: boolean;
}

export interface Body {
  name: string;
  locals: LocalDecl[];
  blocks: BasicBlock[];
  loans: Loan[];
  argCount: number;
}

// ---------------------------------------------------------------------------
// Pretty printing (used by the playground's MIR view and by tests)
// ---------------------------------------------------------------------------

export function placeToString(p: Place): string {
  let s = `_${p.local}`;
  for (const pr of p.proj) {
    if (pr.k === "deref") s = `(*${s})`;
    else if (pr.k === "field") s = `${s}.${pr.variant !== undefined ? `<v${pr.variant}>` : ""}${pr.name ?? pr.index}`;
    else s = `${s}[_]`;
  }
  return s;
}

function opToString(o: Operand): string {
  return o.k === "const" ? "const" : `${o.k} ${placeToString(o.place)}`;
}

function rvToString(rv: Rvalue): string {
  switch (rv.k) {
    case "use": return opToString(rv.op);
    case "ref": return `&${rv.mutable ? "mut " : ""}${placeToString(rv.place)}  // loan L${rv.loan}`;
    case "aggregate": return `{${rv.ops.map(opToString).join(", ")}}`;
    case "call": return `call ${rv.name}(${rv.ops.map(opToString).join(", ")})`;
    case "pure": return `op(${rv.ops.map(opToString).join(", ")})`;
  }
}

export function bodyToString(body: Body, show: (t: Ty) => string): string {
  const out: string[] = [`fn ${body.name} {`];
  body.locals.forEach((l, i) => {
    out.push(`    let ${l.mutable ? "mut " : ""}_${i}: ${show(l.ty)};${l.name ? `  // ${l.kind === "return" ? "return place" : l.name}` : l.kind === "temp" ? "  // temp" : ""}`);
  });
  body.blocks.forEach((b, i) => {
    out.push("", `    bb${i}: {`);
    for (const s of b.stmts) {
      if (s.k === "assign") out.push(`        ${placeToString(s.dest)} = ${rvToString(s.rv)};`);
      else if (s.k === "inspect") out.push(`        inspect(${placeToString(s.place)});`);
      else out.push(`        StorageDead(_${s.local});`);
    }
    const t = b.term;
    out.push(`        ${t.k === "goto" ? `goto -> bb${t.target}` : t.k === "switch" ? `switch -> [${t.targets.map((x) => `bb${x}`).join(", ")}]` : t.k};`);
    out.push("    }");
  });
  out.push("}");
  return out.join("\n");
}
