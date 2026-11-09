/**
 * # Tokens
 *
 * The lexer turns a flat string of characters into a flat list of tokens.
 * A token is the smallest unit of meaning: a keyword like `fn`, an
 * identifier like `main`, a literal like `42i64`, or a punctuation mark
 * like `->`.
 *
 * Tokens carry their {@link Span} so later stages can point error messages
 * back at the original text.
 */
import type { Span } from "../diagnostics.ts";

export type TokenKind =
  | "ident"
  | "keyword"
  | "int"
  | "float"
  | "string"
  | "char"
  | "lifetime"
  | "punct"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** The exact source text, e.g. `0xff_u8` or `"hi\n"` (with quotes). */
  text: string;
  span: Span;
  /** Decoded value for literals: a number for ints/floats, a string for strings/chars, the name for idents/keywords/punct. */
  value: string | number;
  /** Literal type suffix like `i64` in `10i64`, if any. */
  suffix?: string;
  /**
   * True when the next token starts immediately after this one, with no
   * whitespace. The parser uses this to glue `>` `>` back into a `>>` shift
   * operator, while still letting `Vec<Vec<i32>>` close two generic lists.
   */
  joint: boolean;
}

/**
 * Strict keywords. Rust reserves more than this, but these are the ones TSRust
 * gives meaning to.
 */
export const KEYWORDS = new Set([
  "as", "break", "const", "continue", "crate", "else", "enum", "false", "fn", "for",
  "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
  "return", "self", "Self", "struct", "super", "trait", "true", "type", "use", "where", "while",
]);

/**
 * Multi-character punctuation, longest first so the lexer can use "maximal
 * munch": always take the longest operator that matches. Note that `>>` and
 * `<<` are deliberately absent; see {@link Token.joint}.
 */
export const PUNCTUATION = [
  "<<=", ">>=", "..=", "...", "::", "->", "=>", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%=",
  "^=", "&=", "|=", "..",
  "+", "-", "*", "/", "%", "^", "!", "&", "|", "=", "<", ">", "@", ".", ",", ";", ":", "#", "$", "?",
  "(", ")", "[", "]", "{", "}",
];
