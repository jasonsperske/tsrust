/**
 * # Stage 1: Lexing
 *
 * ```mermaid
 * flowchart LR
 *   src["fn main() { let x = 1; }"] --> L[Lexer]
 *   L --> t1[keyword fn] --> t2[ident main] --> t3["punct ("] --> t4["punct )"] --> dots[...]
 * ```
 *
 * The lexer is a hand-written loop over characters. At each position it looks
 * at the current character and decides which kind of token starts here:
 *
 * - whitespace and comments are skipped (block comments nest in Rust!)
 * - a letter or `_` starts an identifier or keyword
 * - a digit starts a number literal, which may carry a type suffix (`10u8`)
 * - `"` starts a string, `'` starts either a char literal or a lifetime
 * - anything else is matched against the punctuation table, longest first
 *
 * The lexer never fails hard: unknown characters produce a diagnostic and are
 * skipped, so the parser still gets a useful token stream.
 */
import { Diagnostics, type Span } from "../diagnostics.ts";
import { KEYWORDS, PUNCTUATION, type Token, type TokenKind } from "./token.ts";

const INT_SUFFIXES = ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize"];
const FLOAT_SUFFIXES = ["f32", "f64"];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentContinue = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

export function lex(text: string, fileId: number, diags: Diagnostics): Token[] {
  return new Lexer(text, fileId, diags).run();
}

class Lexer {
  private pos = 0;
  private readonly tokens: Token[] = [];
  private readonly text: string;
  private readonly file: number;
  private readonly diags: Diagnostics;

  constructor(text: string, file: number, diags: Diagnostics) {
    this.text = text;
    this.file = file;
    this.diags = diags;
  }

  run(): Token[] {
    while (true) {
      this.skipTrivia();
      if (this.pos >= this.text.length) break;
      const start = this.pos;
      const c = this.text[this.pos];
      if (isIdentStart(c)) this.identOrKeyword();
      else if (isDigit(c)) this.number();
      else if (c === '"') this.string();
      else if (c === "'") this.charOrLifetime();
      else if (!this.punct()) {
        this.diags.error("lex", this.span(start, start + 1), `unknown start of token: ${JSON.stringify(c)}`);
        this.pos++;
      }
    }
    this.tokens.push({ kind: "eof", text: "", span: this.span(this.pos, this.pos), value: "", joint: false });
    // Mark tokens that are immediately followed by another token.
    for (let i = 0; i + 1 < this.tokens.length; i++) {
      this.tokens[i].joint = this.tokens[i].span.end === this.tokens[i + 1].span.start;
    }
    return this.tokens;
  }

  private span(start: number, end: number): Span {
    return { file: this.file, start, end };
  }

  private push(kind: TokenKind, start: number, value: string | number, suffix?: string) {
    this.tokens.push({ kind, text: this.text.slice(start, this.pos), span: this.span(start, this.pos), value, suffix, joint: false });
  }

  /** Skip whitespace, line comments, and block comments (which nest in Rust, unlike C). */
  private skipTrivia() {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === "/" && t[this.pos + 1] === "/") {
        while (this.pos < t.length && t[this.pos] !== "\n") this.pos++;
      } else if (c === "/" && t[this.pos + 1] === "*") {
        const start = this.pos;
        let depth = 0;
        do {
          if (t.startsWith("/*", this.pos)) { depth++; this.pos += 2; }
          else if (t.startsWith("*/", this.pos)) { depth--; this.pos += 2; }
          else this.pos++;
        } while (depth > 0 && this.pos < t.length);
        if (depth > 0) this.diags.error("lex", this.span(start, start + 2), "unterminated block comment");
      } else {
        break;
      }
    }
  }

  private identOrKeyword() {
    const start = this.pos;
    while (this.pos < this.text.length && isIdentContinue(this.text[this.pos])) this.pos++;
    const word = this.text.slice(start, this.pos);
    this.push(KEYWORDS.has(word) ? "keyword" : "ident", start, word);
  }

  /**
   * Numbers: `42`, `1_000`, `0xff`, `0b1010`, `3.14`, `1e9`, `7u8`, `2.5f64`.
   * A `.` only belongs to the number if a digit follows, so `1..10` lexes as
   * `1` `..` `10` and `x.0.1` style tuple access keeps working.
   */
  private number() {
    const t = this.text;
    const start = this.pos;
    let radix = 10;
    let isFloat = false;
    if (t[this.pos] === "0" && /[xob]/.test(t[this.pos + 1] ?? "")) {
      radix = { x: 16, o: 8, b: 2 }[t[this.pos + 1] as "x" | "o" | "b"];
      this.pos += 2;
      const digit = radix === 16 ? /[0-9a-fA-F_]/ : radix === 8 ? /[0-7_]/ : /[01_]/;
      while (digit.test(t[this.pos] ?? "")) this.pos++;
      if (/[0-9]/.test(t[this.pos] ?? "")) {
        this.diags.error("lex", this.span(this.pos, this.pos + 1), `invalid digit for a base ${radix} literal`);
        while (/[0-9]/.test(t[this.pos] ?? "")) this.pos++;
      }
    } else {
      while (/[0-9_]/.test(t[this.pos] ?? "")) this.pos++;
      if (t[this.pos] === "." && isDigit(t[this.pos + 1] ?? "")) {
        isFloat = true;
        this.pos++;
        while (/[0-9_]/.test(t[this.pos] ?? "")) this.pos++;
      }
      if (/[eE]/.test(t[this.pos] ?? "") && /[0-9+-]/.test(t[this.pos + 1] ?? "")) {
        isFloat = true;
        this.pos += 2;
        while (/[0-9_]/.test(t[this.pos] ?? "")) this.pos++;
      }
    }
    const digitsEnd = this.pos;
    let suffix: string | undefined;
    if (isIdentStart(t[this.pos] ?? "")) {
      const sStart = this.pos;
      while (this.pos < t.length && isIdentContinue(t[this.pos])) this.pos++;
      suffix = t.slice(sStart, this.pos);
      if (FLOAT_SUFFIXES.includes(suffix)) isFloat = true;
      else if (!INT_SUFFIXES.includes(suffix)) {
        this.diags.error("lex", this.span(sStart, this.pos), `invalid suffix \`${suffix}\` for number literal`);
        suffix = undefined;
      }
    }
    const digits = t.slice(start, digitsEnd).replace(/_/g, "");
    if (isFloat) {
      this.push("float", start, parseFloat(digits), suffix);
    } else {
      const body = radix === 10 ? digits : digits.slice(2);
      this.push("int", start, parseInt(body, radix), suffix);
    }
  }

  /** Decode one escape sequence after a backslash. Returns the decoded text. */
  private escape(): string {
    const start = this.pos;
    this.pos++; // the backslash
    const c = this.text[this.pos++];
    switch (c) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "u": {
        const m = /^\{([0-9a-fA-F_]{1,6})\}/.exec(this.text.slice(this.pos));
        if (m) {
          this.pos += m[0].length;
          return String.fromCodePoint(parseInt(m[1].replace(/_/g, ""), 16));
        }
        break;
      }
    }
    this.diags.error("lex", this.span(start, this.pos), `unknown character escape: \`${c ?? ""}\``);
    return c ?? "";
  }

  private string() {
    const start = this.pos++;
    let value = "";
    while (this.pos < this.text.length && this.text[this.pos] !== '"') {
      if (this.text[this.pos] === "\\") {
        // A backslash before a newline skips the newline and leading whitespace.
        if (this.text[this.pos + 1] === "\n") {
          this.pos += 2;
          while (/[ \t\r\n]/.test(this.text[this.pos] ?? "")) this.pos++;
        } else {
          value += this.escape();
        }
      } else {
        value += this.text[this.pos++];
      }
    }
    if (this.pos >= this.text.length) {
      this.diags.error("lex", this.span(start, start + 1), "unterminated double quote string");
    } else {
      this.pos++;
    }
    this.push("string", start, value);
  }

  /**
   * `'a'` is a char, `'\n'` is a char, but `'a` (no closing quote) is a
   * lifetime. We peek ahead to decide.
   */
  private charOrLifetime() {
    const start = this.pos;
    const t = this.text;
    if (isIdentStart(t[start + 1] ?? "") && t[start + 2] !== "'") {
      this.pos++;
      while (this.pos < t.length && isIdentContinue(t[this.pos])) this.pos++;
      this.push("lifetime", start, t.slice(start + 1, this.pos));
      return;
    }
    this.pos++;
    let value: string;
    if (t[this.pos] === "\\") value = this.escape();
    else {
      const cp = t.codePointAt(this.pos)!;
      value = String.fromCodePoint(cp);
      this.pos += value.length;
    }
    if (t[this.pos] !== "'") {
      this.diags.error("lex", this.span(start, this.pos), "unterminated character literal");
    } else {
      this.pos++;
    }
    this.push("char", start, value);
  }

  private punct(): boolean {
    for (const p of PUNCTUATION) {
      if (this.text.startsWith(p, this.pos)) {
        const start = this.pos;
        this.pos += p.length;
        this.push("punct", start, p);
        return true;
      }
    }
    return false;
  }
}
