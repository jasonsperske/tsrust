/**
 * # Definitions
 *
 * Every named thing the program declares (module, function, struct, enum,
 * variant, trait, impl, constant, type alias, generic parameter) gets a
 * {@link Def} with a numeric {@link DefId}. Later stages refer to items only
 * through `DefId`s, never through names: names are ambiguous ("which `new`?"),
 * ids are not.
 *
 * Rust has two main **namespaces**, and a module can hold the same name in
 * both at once:
 *
 * | Namespace | Holds                                                         |
 * |-----------|---------------------------------------------------------------|
 * | type      | modules, structs, enums, traits, type aliases, generic params |
 * | value     | functions, constants, local variables, *constructors* of tuple/unit structs and variants |
 *
 * That is why `struct Meters(f64);` can be used both as a type (`x: Meters`)
 * and as a function (`Meters(5.0)`): the declaration puts one entry in each
 * namespace.
 */
import type { Span } from "../diagnostics.ts";
import type * as A from "../parser/ast.ts";

export type DefId = number;

export type DefKind =
  | "mod" | "fn" | "struct" | "enum" | "variant" | "trait" | "impl" | "const" | "typeAlias" | "assocTy" | "tyParam";

export type Namespace = "type" | "value";

export interface Binding {
  res: Res;
  isPub: boolean;
  span: Span;
  /** True for bindings introduced by `use`, so we can report "imported here". */
  isImport: boolean;
}

/** The scope of names inside a module (or an enum, whose variants live in it). */
export interface ModuleScope {
  types: Map<string, Binding>;
  values: Map<string, Binding>;
  /** `use path::*;` imports, resolved to the module/enum they glob from. */
  globs: { target: DefId; isPub: boolean }[];
}

export interface Def {
  id: DefId;
  kind: DefKind;
  name: string;
  crate: number;
  /** The enclosing module (for items), enum (for variants), impl/trait (for associated items) or item (for generic params). */
  parent?: DefId;
  /** The module whose privacy rules apply to this def. */
  module: DefId;
  isPub: boolean;
  span: Span;
  /** The AST node. Variants and generic params point at their parent item. */
  node?: A.Item | A.FnItem | A.TypeAliasItem | A.ConstItem;
  /** For modules (including anonymous block modules) and enums. */
  scope?: ModuleScope;
  /** For variants. */
  variant?: A.Variant;
  variantIndex?: number;
  /** For generic params: index within the owning item's own generic list. */
  paramIndex?: number;
  /** For generic params: their bounds as written. */
  bounds?: A.Path[];
  /** True for function declarations without a body in `std` (VM intrinsics). */
  intrinsic?: boolean;
}

/** What a name resolved to. */
export type Res =
  | { kind: "def"; def: DefId }
  | { kind: "local"; id: A.NodeId }
  | { kind: "prim"; name: PrimName }
  /** `Self`: inside an impl it is the impl's self type; inside a trait, the implementing type. */
  | { kind: "selfTy"; owner: DefId }
  | { kind: "err" };

export const PRIMITIVES = [
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize",
  "f32", "f64", "bool", "char", "str",
] as const;
export type PrimName = (typeof PRIMITIVES)[number];

export function isPrim(name: string): name is PrimName {
  return (PRIMITIVES as readonly string[]).includes(name);
}

/**
 * A path that resolved only partway. `Point::new` resolves `Point` to a
 * struct, but `new` is an associated function that only the type checker can
 * find (it depends on impls). The unresolved tail is left for later.
 */
export interface PartialRes {
  base: Res;
  /** Path segments after the resolved base, e.g. `["new"]`. Empty when fully resolved. */
  unresolved: A.PathSegment[];
  /** Index into the path's segments of the segment that produced `base`. */
  baseIndex: number;
}
