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
  | "string"; // String → str (Deref coercion)

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
  /** Field expressions and struct-literal fields → field index. */
  fieldIndices: Map<A.NodeId, number>;
  locals: Map<A.NodeId, LocalInfo>;
  forLoops: Map<A.NodeId, ForLoopInfo>;
  /** Index expressions that slice a string by a range: `&s[a..b]`. */
  strSlices: Set<A.NodeId>;
  /** `?` expressions: which family they propagate. */
  tryKinds: Map<A.NodeId, "option" | "result">;
  /** Methods/fns whose bodies were checked, with their param binding ids. */
  checkedBodies: DefId[];
}

export function emptyResults(): TypeckResults {
  return {
    types: new Map(), callees: new Map(), ctors: new Map(), adjustments: new Map(), coercions: new Map(),
    bindingModes: new Map(), patDerefs: new Map(), fieldIndices: new Map(), locals: new Map(),
    forLoops: new Map(), tryKinds: new Map(), strSlices: new Set(), checkedBodies: [],
  };
}
