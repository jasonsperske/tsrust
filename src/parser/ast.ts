/**
 * # The Abstract Syntax Tree
 *
 * The parser turns tokens into this tree. The AST mirrors the *surface
 * syntax* of Rust closely: it knows nothing about types, which names refer to
 * what, or who owns which value. Those facts are discovered by later stages
 * and stored in **side tables** keyed by each node's numeric `id`:
 *
 * ```mermaid
 * flowchart LR
 *   AST["AST node<br/>id = 42"] -->|resolve| R["resolutions.get(42)<br/>= local #3"]
 *   AST -->|typeck| T["types.get(42)<br/>= i32"]
 *   AST -->|borrowck| B["moves / borrows<br/>at node 42"]
 * ```
 *
 * Keeping the tree immutable and putting analysis results beside it (rather
 * than mutating fields on nodes) is exactly what rustc does with its
 * `HirId`-keyed tables, and it keeps every stage easy to test in isolation.
 */
import type { Span } from "../diagnostics.ts";

export type NodeId = number;

interface Node {
  id: NodeId;
  span: Span;
}

// ---------------------------------------------------------------------------
// Paths:  `x`, `Vec::new`, `crate::shapes::Circle`, `Option::<i32>::None`
// ---------------------------------------------------------------------------

export interface PathSegment {
  name: string;
  /** Generic arguments written on this segment, e.g. `Vec::<i32>` or `Option<T>` in type position. */
  generics?: TypeExpr[];
  /** Lifetime arguments, e.g. `'a` in `Parser<'a>`. */
  lifetimes?: string[];
  /** Associated type bindings in bounds, e.g. `Item = A` in `Iterator<Item = A>`. */
  bindings?: { name: string; ty: TypeExpr; span: Span }[];
  span: Span;
}

export interface Path extends Node {
  segments: PathSegment[];
}

// ---------------------------------------------------------------------------
// Types as written in the source
// ---------------------------------------------------------------------------

export type TypeExpr =
  | ({ kind: "path"; path: Path } & Node)
  | ({ kind: "ref"; mutable: boolean; lifetime?: string; inner: TypeExpr } & Node)
  | ({ kind: "tuple"; elems: TypeExpr[] } & Node)
  /** `<T as Iterator>::Item` — a qualified path to an associated type. */
  | ({ kind: "qpath"; self: TypeExpr; trait: Path; name: string } & Node)
  | ({ kind: "infer" } & Node)
  | ({ kind: "never" } & Node);

// ---------------------------------------------------------------------------
// Items: the things that live at module level
// ---------------------------------------------------------------------------

export interface GenericParam {
  name: string;
  /** Trait bounds, from both `<T: Display>` and `where T: Display`. */
  bounds: Path[];
  /** Default type, as in `trait Add<Rhs = Self>`. */
  default?: TypeExpr;
  span: Span;
}

export interface Generics {
  lifetimes: string[];
  params: GenericParam[];
}

export type SelfParamKind = "value" | "ref" | "refMut";

export interface Param extends Node {
  pat: Pattern;
  ty: TypeExpr;
}

export interface FnItem extends Node {
  kind: "fn";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  generics: Generics;
  /** `self`, `&self`, `&mut self` (or `mut self`). Absent for free and associated functions. */
  selfParam?: { id: NodeId; kind: SelfParamKind; mutable: boolean; span: Span };
  params: Param[];
  ret?: TypeExpr;
  /** Absent for a trait method declaration without a default body. */
  body?: BlockExpr;
}

export type FieldsKind = "named" | "tuple" | "unit";

export interface FieldDef {
  name: string; // "0", "1"... for tuple fields
  ty: TypeExpr;
  isPub: boolean;
  span: Span;
}

export interface StructItem extends Node {
  kind: "struct";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  generics: Generics;
  fieldsKind: FieldsKind;
  fields: FieldDef[];
  derives: string[];
}

export interface Variant {
  name: string;
  fieldsKind: FieldsKind;
  fields: FieldDef[];
  span: Span;
}

export interface EnumItem extends Node {
  kind: "enum";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  generics: Generics;
  variants: Variant[];
  derives: string[];
}

export interface ImplItem extends Node {
  kind: "impl";
  generics: Generics;
  /** `impl Trait for Type` sets this; inherent `impl Type` leaves it unset. */
  traitPath?: Path;
  selfTy: TypeExpr;
  items: FnItem[];
  /** `type Item = u32;` inside a trait impl. */
  assocTypes: TypeAliasItem[];
  /** `const MAX: i32 = ...;` inside an inherent impl. */
  consts: ConstItem[];
}

export interface TraitItem extends Node {
  kind: "trait";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  generics: Generics;
  /** `trait Ord: Eq + PartialOrd` — implementing `Ord` requires the supertraits too. */
  supertraits: Path[];
  items: FnItem[];
  /** `type Item;` declarations: associated types the implementor must provide. */
  assocTypes: TypeAliasItem[];
}

/** `type Name<T> = Ty;` at module level, or `type Item = Ty;` / `type Item;` in impls and traits. */
export interface TypeAliasItem extends Node {
  kind: "type";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  generics: Generics;
  ty?: TypeExpr;
}

export interface ModItem extends Node {
  kind: "mod";
  name: string;
  isPub: boolean;
  /** Inline `mod m { ... }` has items here. `mod m;` is filled in by the crate loader. */
  items?: Item[];
  /** Set by the crate loader when the body came from another file. */
  file?: number;
}

/** `use a::b::{c, d as e, f::*};` */
export type UseTree =
  | { kind: "simple"; path: string[]; alias?: string; span: Span }
  | { kind: "glob"; path: string[]; span: Span }
  | { kind: "nested"; path: string[]; trees: UseTree[]; span: Span };

export interface UseItem extends Node {
  kind: "use";
  isPub: boolean;
  tree: UseTree;
}

export interface ConstItem extends Node {
  kind: "const";
  name: string;
  nameSpan: Span;
  isPub: boolean;
  ty: TypeExpr;
  value: Expr;
}

export type Item = FnItem | StructItem | EnumItem | ImplItem | TraitItem | ModItem | UseItem | ConstItem | TypeAliasItem;

// ---------------------------------------------------------------------------
// Patterns: the left-hand side of `let`, `match` arms, function params
// ---------------------------------------------------------------------------

export type Pattern =
  | ({ kind: "wild" } & Node)
  | ({ kind: "ident"; name: string; mutable: boolean; byRef: boolean; sub?: Pattern } & Node)
  | ({ kind: "lit"; value: Literal; negative: boolean } & Node)
  | ({ kind: "range"; lo: Literal; hi: Literal; inclusive: boolean } & Node)
  | ({ kind: "tuple"; elems: Pattern[] } & Node)
  /** A bare path such as `None` or `Color::Red`. */
  | ({ kind: "path"; path: Path } & Node)
  | ({ kind: "tupleStruct"; path: Path; elems: Pattern[] } & Node)
  | ({ kind: "struct"; path: Path; fields: { name: string; pat: Pattern; span: Span }[]; rest: boolean } & Node)
  | ({ kind: "ref"; mutable: boolean; inner: Pattern } & Node)
  | ({ kind: "or"; alts: Pattern[] } & Node);

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Literal =
  | { kind: "int"; value: number; suffix?: string }
  | { kind: "float"; value: number; suffix?: string }
  | { kind: "bool"; value: boolean }
  | { kind: "str"; value: string }
  | { kind: "char"; value: string };

export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||"
  | "&" | "|" | "^" | "<<" | ">>";

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=" | "&=" | "|=" | "<<=" | ">>=";

/** A piece of a parsed format string: literal text or a `{}` / `{:?}` hole. */
export type FormatPiece =
  | { kind: "text"; text: string }
  | { kind: "hole"; arg: number; debug: boolean; pretty: boolean; precision?: number };

/** A parsed format string, as used by `println!`, `format!`, `panic!` and friends. */
export interface FormatSpec {
  pieces: FormatPiece[];
  args: Expr[];
  span: Span;
}

export interface BlockExpr extends Node {
  kind: "block";
  stmts: Stmt[];
  /** The final expression without a semicolon: the block's value. */
  tail?: Expr;
}

export interface MatchArm {
  pat: Pattern;
  guard?: Expr;
  body: Expr;
  span: Span;
}

export type Expr =
  | ({ kind: "lit"; value: Literal } & Node)
  | ({ kind: "path"; path: Path } & Node)
  | ({ kind: "unary"; op: "-" | "!" | "*"; expr: Expr } & Node)
  | ({ kind: "ref"; mutable: boolean; expr: Expr } & Node)
  | ({ kind: "binary"; op: BinaryOp; left: Expr; right: Expr } & Node)
  | ({ kind: "assign"; op: AssignOp; target: Expr; value: Expr } & Node)
  | ({ kind: "call"; callee: Expr; args: Expr[] } & Node)
  | ({ kind: "methodCall"; receiver: Expr; method: string; methodSpan: Span; generics?: TypeExpr[]; args: Expr[] } & Node)
  | ({ kind: "field"; expr: Expr; name: string; nameSpan: Span } & Node)
  | ({ kind: "index"; expr: Expr; index: Expr } & Node)
  | ({ kind: "structLit"; path: Path; fields: { name: string; value: Expr; span: Span }[]; base?: Expr } & Node)
  | ({ kind: "tuple"; elems: Expr[] } & Node)
  | BlockExpr
  | ({ kind: "if"; cond: Expr; then: BlockExpr; else?: Expr } & Node)
  | ({ kind: "while"; label?: string; cond: Expr; body: BlockExpr } & Node)
  | ({ kind: "loop"; label?: string; body: BlockExpr } & Node)
  | ({ kind: "for"; label?: string; pat: Pattern; iter: Expr; body: BlockExpr } & Node)
  | ({ kind: "break"; label?: string; value?: Expr } & Node)
  | ({ kind: "continue"; label?: string } & Node)
  | ({ kind: "return"; value?: Expr } & Node)
  | ({ kind: "match"; scrutinee: Expr; arms: MatchArm[]; source: "match" | "if let" | "while let" } & Node)
  | ({ kind: "range"; start?: Expr; end?: Expr; inclusive: boolean } & Node)
  | ({ kind: "cast"; expr: Expr; ty: TypeExpr } & Node)
  | ({ kind: "try"; expr: Expr } & Node)
  /**
   * Built-in macros. `args` are the leading expression arguments (`assert_eq!(a, b, ..)`
   * has two); `format` is the optional format string and its arguments. For
   * `vec![x; n]`, `repeat` is true and `args` is `[x, n]`.
   */
  | ({ kind: "macro"; name: string; args: Expr[]; format?: FormatSpec; repeat?: boolean } & Node);

export type Stmt =
  | ({ kind: "let"; pat: Pattern; ty?: TypeExpr; init?: Expr } & Node)
  | ({ kind: "expr"; expr: Expr; semi: boolean } & Node)
  | ({ kind: "item"; item: Item } & Node);

/** One parsed source file. */
export interface SourceModule {
  file: number;
  items: Item[];
}

/** Hands out unique node ids across every file of a compilation. */
export class NodeIdGen {
  private next = 0;
  fresh(): NodeId {
    return this.next++;
  }
}
