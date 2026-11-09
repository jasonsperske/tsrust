/**
 * # Semantic types
 *
 * The parser's {@link A.TypeExpr} is *syntax*: what the user wrote. A
 * {@link Ty} is *meaning*: `Vec<i32>`, `&mut String`, or `?3` (an unknown we
 * are still inferring). Type expressions are converted to `Ty`s once names
 * are resolved.
 *
 * ```mermaid
 * classDiagram
 *   class Ty
 *   Ty <|-- Int : i8..usize
 *   Ty <|-- Float : f32, f64
 *   Ty <|-- Bool
 *   Ty <|-- Char
 *   Ty <|-- Str : str (unsized)
 *   Ty <|-- Tuple : (A, B) and ()
 *   Ty <|-- Ref : &T / &mut T
 *   Ty <|-- Adt : struct/enum + generic args
 *   Ty <|-- Param : T in fn foo<T>
 *   Ty <|-- Proj : <T as Iterator>::Item
 *   Ty <|-- Var : ?N inference variable
 *   Ty <|-- Never : !
 * ```
 *
 * Lifetimes are *erased* from `Ty`: the type checker treats `&'a T` and
 * `&'b T` as the same type. Checking lifetimes is the borrow checker's job.
 */
import type { DefId } from "../resolve/defs.ts";

export const INT_TYPES = ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize"] as const;
export type IntName = (typeof INT_TYPES)[number];
export type FloatName = "f32" | "f64";

export type Ty =
  | { k: "int"; name: IntName }
  | { k: "float"; name: FloatName }
  | { k: "bool" }
  | { k: "char" }
  | { k: "str" }
  | { k: "never" }
  | { k: "tuple"; elems: Ty[] }
  | { k: "ref"; mutable: boolean; inner: Ty }
  | { k: "adt"; def: DefId; args: Ty[] }
  | { k: "param"; def: DefId; name: string }
  /** An associated type projection that can't be normalized yet, e.g. `I::Item` inside `fn f<I: Iterator>`. */
  | { k: "proj"; trait: DefId; traitArgs: Ty[]; self: Ty; name: string }
  | { k: "var"; id: number }
  | { k: "error" };

export const UNIT: Ty = { k: "tuple", elems: [] };
export const BOOL: Ty = { k: "bool" };
export const CHAR: Ty = { k: "char" };
export const STR: Ty = { k: "str" };
export const NEVER: Ty = { k: "never" };
export const ERROR: Ty = { k: "error" };
export const USIZE: Ty = { k: "int", name: "usize" };
export const I32: Ty = { k: "int", name: "i32" };
export const F64: Ty = { k: "float", name: "f64" };
export const REF_STR: Ty = { k: "ref", mutable: false, inner: STR };

export const isUnit = (t: Ty) => t.k === "tuple" && t.elems.length === 0;
export const isSigned = (n: IntName) => n.startsWith("i");

/** A mapping from generic parameter DefIds to the types substituted for them. */
export type Subst = Map<DefId, Ty>;

/** Replace generic params in `t` according to `subst`. */
export function substitute(t: Ty, subst: Subst): Ty {
  if (subst.size === 0) return t;
  switch (t.k) {
    case "param": return subst.get(t.def) ?? t;
    case "tuple": return { k: "tuple", elems: t.elems.map((e) => substitute(e, subst)) };
    case "ref": return { k: "ref", mutable: t.mutable, inner: substitute(t.inner, subst) };
    case "adt": return { k: "adt", def: t.def, args: t.args.map((a) => substitute(a, subst)) };
    case "proj": return { k: "proj", trait: t.trait, traitArgs: t.traitArgs.map((a) => substitute(a, subst)), self: substitute(t.self, subst), name: t.name };
    default: return t;
  }
}

/** Apply `f` to every directly nested type. */
export function mapTy(t: Ty, f: (t: Ty) => Ty): Ty {
  switch (t.k) {
    case "tuple": return { k: "tuple", elems: t.elems.map(f) };
    case "ref": return { k: "ref", mutable: t.mutable, inner: f(t.inner) };
    case "adt": return { k: "adt", def: t.def, args: t.args.map(f) };
    case "proj": return { k: "proj", trait: t.trait, traitArgs: t.traitArgs.map(f), self: f(t.self), name: t.name };
    default: return t;
  }
}

/** Does `t` mention any of the given kinds anywhere inside? */
export function containsKind(t: Ty, kinds: Ty["k"][]): boolean {
  if (kinds.includes(t.k)) return true;
  switch (t.k) {
    case "tuple": return t.elems.some((e) => containsKind(e, kinds));
    case "ref": return containsKind(t.inner, kinds);
    case "adt": return t.args.some((e) => containsKind(e, kinds));
    case "proj": return containsKind(t.self, kinds) || t.traitArgs.some((e) => containsKind(e, kinds));
    default: return false;
  }
}

export function tyEquals(a: Ty, b: Ty): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "int": return a.name === (b as typeof a).name;
    case "float": return a.name === (b as typeof a).name;
    case "tuple": { const bb = b as typeof a; return a.elems.length === bb.elems.length && a.elems.every((e, i) => tyEquals(e, bb.elems[i])); }
    case "ref": { const bb = b as typeof a; return a.mutable === bb.mutable && tyEquals(a.inner, bb.inner); }
    case "adt": { const bb = b as typeof a; return a.def === bb.def && a.args.every((e, i) => tyEquals(e, bb.args[i])); }
    case "param": return a.def === (b as typeof a).def;
    case "proj": { const bb = b as typeof a; return a.trait === bb.trait && a.name === bb.name && tyEquals(a.self, bb.self) && a.traitArgs.every((e, i) => tyEquals(e, bb.traitArgs[i])); }
    case "var": return a.id === (b as typeof a).id;
    default: return true;
  }
}

/** A stable string key for a fully-known type; used for monomorphization caches. */
export function tyKey(t: Ty): string {
  switch (t.k) {
    case "int": case "float": return t.name;
    case "tuple": return `(${t.elems.map(tyKey).join(",")})`;
    case "ref": return `&${t.mutable ? "mut " : ""}${tyKey(t.inner)}`;
    case "adt": return `#${t.def}${t.args.length ? `<${t.args.map(tyKey).join(",")}>` : ""}`;
    case "param": return `P${t.def}`;
    case "proj": return `<${tyKey(t.self)} as #${t.trait}>::${t.name}`;
    case "var": return `?${t.id}`;
    default: return t.k;
  }
}

/** Pretty-print a type the way rustc shows it in error messages. */
export function showTy(t: Ty, nameOf: (def: DefId) => string, varName?: (id: number) => string | undefined): string {
  const go = (t: Ty): string => {
    switch (t.k) {
      case "int": case "float": return t.name;
      case "bool": case "char": case "str": return t.k;
      case "never": return "!";
      case "error": return "{error}";
      case "tuple": return t.elems.length === 1 ? `(${go(t.elems[0])},)` : `(${t.elems.map(go).join(", ")})`;
      case "ref": return `&${t.mutable ? "mut " : ""}${go(t.inner)}`;
      case "adt": return `${nameOf(t.def)}${t.args.length ? `<${t.args.map(go).join(", ")}>` : ""}`;
      case "param": return t.name;
      case "proj": return `<${go(t.self)} as ${nameOf(t.trait)}>::${t.name}`;
      case "var": return varName?.(t.id) ?? "_";
    }
  };
  return go(t);
}
