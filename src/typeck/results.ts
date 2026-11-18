/**
 * # Type-checking results
 *
 * Everything the type checker learns is written into side tables keyed by
 * AST node id. The borrow checker and code generator read these instead of
 * redoing any analysis. All types stored here are fully resolved (no
 * inference variables remain), but they may still mention generic params:
 * the code generator substitutes concrete types when monomorphizing.
 */
import type * as A from "../parser/ast.ts";
import type { DefId } from "../resolve/defs.ts";
import type { Ty } from "./types.ts";

/** One step of auto-dereferencing. */
export type DerefStep =
  | "ref" // &T → T
  | "box" // Box<T> → T
  | "string" // String → str (Deref coercion)
  | "vec" // Vec<T> → [T]
  | "unsize" // [T; N] → [T]
  | "fnptr"; // a fn item or non-capturing closure → fn pointer (coercions only)

export type ClosureKind = "Fn" | "FnMut" | "FnOnce";

/** One step of a captured place: `x.0`, `*x`. */
export type CaptureProj = { k: "field"; index: number } | { k: "deref"; via: "ref" | "refMut" | "box" | "raw" | "rawMut" | "other" };

/** One thing a closure captures, found by `borrowck/captures.ts`. */
export interface Capture {
  root: A.NodeId;
  proj: CaptureProj[];
  /** How the place is held: by reference, or (`undefined`) by value. */
  by?: "ref" | "mut";
  /** The type of the captured place itself. */
  ty: Ty;
}

export interface ClosureInfo {
  node: Extract<A.Expr, { kind: "closure" }>;
  /** The function or const whose body contains the closure. */
  owner: DefId;
  params: Ty[];
  ret: Ty;
  /** From the bound it was passed to (`F: Fn(..)`), if any. */
  expectedKind?: ClosureKind;
  /** Bounds it must satisfy, checked once its kind is known. */
  required: { kind: ClosureKind; span: A.Expr["span"] }[];
  /** Filled in by capture analysis, after type checking. */
  captures?: Capture[];
  kind?: ClosureKind;
  /** Set when it was coerced to a `fn` pointer, which requires it to capture nothing. */
  toFnPtr?: A.Expr["span"];
}

/**
 * Implicit operations inserted on an expression: dereference it `derefs`
 * times, then optionally borrow the result. This is how `v.len()` with
 * `v: Vec<T>` becomes `Vec::len(&v)`.
 */
export interface Adjustment {
  derefs: DerefStep[];
  autoref?: "ref" | "mut";
}

/**
 * What a call, method call or overloaded operator invokes. `substs` gives a
 * type for every generic param of `def` (see `TyCtxt.allParams`). When `def` is
 * a trait method, the concrete implementation is chosen later, during
 * monomorphization, once `Self` (`substs[0]`) is known.
 */
export interface Callee {
  def: DefId;
  substs: Ty[];
}

export type BindingMode = "move" | "ref" | "refMut";

export interface LocalInfo {
  name: string;
  ty: Ty;
  mutable: boolean;
  span: A.Pattern["span"];
}

export interface ForLoopInfo {
  /** `IntoIterator::into_iter` for the iterated expression's type. */
  intoIter: Callee;
  /** `Iterator::next` for the resulting iterator type. */
  next: Callee;
  iterTy: Ty;
  itemTy: Ty;
}

export interface TypeckResults {
  /** Type of every expression and pattern (for patterns: the type being matched, after match-ergonomics derefs). */
  types: Map<A.NodeId, Ty>;
  /** Calls, method calls, overloaded operators, assoc consts. */
  callees: Map<A.NodeId, Callee>;
  /** Struct/variant constructed by a call, path, struct literal or pattern. Holds the ADT's generic args. */
  ctors: Map<A.NodeId, { def: DefId; adtArgs: Ty[] }>;
  /** Receiver / base adjustments, keyed by the adjusted expression's id. */
  adjustments: Map<A.NodeId, Adjustment>;
  /** Coercions applied at coercion sites (`&String` → `&str`, `&mut T` → `&T`). */
  coercions: Map<A.NodeId, DerefStep[]>;
  /** How each binding captures its value. */
  bindingModes: Map<A.NodeId, BindingMode>;
  /** Number of references implicitly peeled before matching a pattern (match ergonomics). */
  patDerefs: Map<A.NodeId, number>;
  /** Field expressions and struct-pattern fields → field index. */
  fieldIndices: Map<A.NodeId, number>;
  /** The value of each field in a struct literal → the field it initializes. */
  litFields: Map<A.NodeId, number>;
  locals: Map<A.NodeId, LocalInfo>;
  forLoops: Map<A.NodeId, ForLoopInfo>;
  /** Index expressions that slice a string by a range: `&s[a..b]`. */
  strSlices: Set<A.NodeId>;
  /** Index expressions that take a sub-slice of a slice, array or `Vec`: `&v[a..b]`. */
  sliceRanges: Set<A.NodeId>;
  /** `==`/`!=` between different sequence types (`vec == [1, 2]`), compared as slices. */
  seqEq: Set<A.NodeId>;
  /** Every closure expression. */
  closures: Map<A.NodeId, ClosureInfo>;
  /** Calls through a value (closure, `F: Fn`, fn pointer), with how `F` is called (undefined for a closure: see its kind). */
  valueCalls: Map<A.NodeId, ClosureKind | undefined>;
  /** Paths naming a const generic parameter. */
  constParams: Map<A.NodeId, Ty>;
  /** Paths naming a `static`. */
  statics: Map<A.NodeId, DefId>;
  /** `?` expressions: which family they propagate. */
  tryKinds: Map<A.NodeId, "option" | "result">;
  /** Methods/fns whose bodies were checked, with their param binding ids. */
  checkedBodies: DefId[];
}

/**
 * Can `&e` live forever? A borrow of a constant expression refers to static
 * data rather than a temporary, so `&[1, 2]` may be returned from a function.
 */
export function isPromotable(e: A.Expr, r: TypeckResults): boolean {
  switch (e.kind) {
    case "lit": return true;
    case "unary": return e.op === "-" && e.expr.kind === "lit";
    case "array": case "tuple": return e.elems.every((x) => isPromotable(x, r));
    case "repeat": return isPromotable(e.value, r);
    case "ref": return !e.mutable && !e.raw && isPromotable(e.expr, r);
    case "path": return r.callees.has(e.id) || r.ctors.has(e.id);
    default: return false;
  }
}

export function emptyResults(): TypeckResults {
  return {
    types: new Map(), callees: new Map(), ctors: new Map(), adjustments: new Map(), coercions: new Map(),
    bindingModes: new Map(), patDerefs: new Map(), fieldIndices: new Map(), locals: new Map(),
    forLoops: new Map(), tryKinds: new Map(), strSlices: new Set(), checkedBodies: [],
    litFields: new Map(), sliceRanges: new Set(), seqEq: new Set(), closures: new Map(), valueCalls: new Map(), constParams: new Map(), statics: new Map(),
  };
}
