/**
 * # Stage 2: Parsing
 *
 * The parser is a classic **recursive-descent** parser: one function per
 * grammar rule (`parseItem`, `parseStmt`, `parseExpr`, `parsePattern`, ...)
 * that consumes tokens and returns AST nodes. Binary operators use
 * **precedence climbing**, so `a + b * c` groups as `a + (b * c)`.
 *
 * ```mermaid
 * flowchart TD
 *   file[parseFile] --> item[parseItem]
 *   item --> fn[parseFn] --> block[parseBlock]
 *   block --> stmt[parseStmt]
 *   stmt --> let[let pattern = expr]
 *   stmt --> expr[parseExpr]
 *   expr --> bin["parseBinary(minPrec)"] --> unary[parseUnary] --> postfix[parsePostfix] --> primary[parsePrimary]
 *   primary -->|"( { if match ..."| expr
 * ```
 *
 * ## Operator precedence (lowest to highest)
 *
 * | Level | Operators                     | Assoc. |
 * |------:|-------------------------------|--------|
 * | 1     | `=` `+=` `-=` ...             | right  |
 * | 2     | `..` `..=`                    | none   |
 * | 3     | `\|\|`                        | left   |
 * | 4     | `&&`                          | left   |
 * | 5     | `==` `!=` `<` `>` `<=` `>=`   | none   |
 * | 6     | `\|`                          | left   |
 * | 7     | `^`                           | left   |
 * | 8     | `&`                           | left   |
 * | 9     | `<<` `>>`                     | left   |
 * | 10    | `+` `-`                       | left   |
 * | 11    | `*` `/` `%`                   | left   |
 * | 12    | `as`                          | left   |
 * | 13    | unary `-` `!` `*` `&` `&mut`  | prefix |
 * | 14    | `.field` `.method()` `()` `[]` `?` | postfix |
 *
 * ## Two famous ambiguities
 *
 * 1. **Struct literals in conditions.** In `if x == S { ... }` is `S { ... }` a
 *    struct literal or is `{ ... }` the `if` body? Rust says the body: struct
 *    literals are not allowed directly in `if`/`while`/`match`/`for` heads. We
 *    track this with the `noStruct` flag.
 * 2. **Generics vs. less-than.** `a < b` versus `Vec<i32>`. In expressions you
 *    must write the "turbofish" `Vec::<i32>::new()`; in type positions `<`
 *    always opens generics.
 *
 * ## Desugaring
 *
 * A few constructs are rewritten into simpler ones right here, just as rustc
 * lowers them from AST to HIR:
 *
 * - `if let P = e { a } else { b }`  becomes `match e { P => a, _ => b }`
 * - `while let P = e { body }`       becomes `loop { match e { P => body, _ => break } }`
 */
import { Diagnostics, joinSpans, type Span } from "../diagnostics.ts";
import type { Token } from "../lexer/token.ts";
import type * as A from "./ast.ts";
import { NodeIdGen } from "./ast.ts";
import { parseFormatString } from "./format.ts";

/** Thrown internally to unwind out of a hopeless parse; caught at item level for recovery. */
class ParseAbort extends Error {}

/** Macros that take a format string as their first (or only) argument. */
const FORMAT_MACROS = new Set(["println", "print", "eprintln", "eprint", "format", "panic", "unreachable", "todo", "unimplemented"]);

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 3, "&&": 4,
  "==": 5, "!=": 5, "<": 5, ">": 5, "<=": 5, ">=": 5,
  "|": 6, "^": 7, "&": 8, "<<": 9, ">>": 9,
  "+": 10, "-": 10, "*": 11, "/": 11, "%": 11,
};
const AS_PRECEDENCE = 12;
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^=", "&=", "|=", "<<=", ">>="]);

export function parseFile(tokens: Token[], file: number, ids: NodeIdGen, diags: Diagnostics): A.SourceModule {
  const p = new Parser(tokens, ids, diags);
  return { file, items: p.parseItemsUntil(null) };
}

/** Parse a single expression, used by tests and the playground's AST explorer. */
export function parseExpression(tokens: Token[], ids: NodeIdGen, diags: Diagnostics): A.Expr | undefined {
  const p = new Parser(tokens, ids, diags);
  try {
    return p.parseExpr();
  } catch (e) {
    if (e instanceof ParseAbort) return undefined;
    throw e;
  }
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly ids: NodeIdGen;
  private readonly diags: Diagnostics;

  constructor(tokens: Token[], ids: NodeIdGen, diags: Diagnostics) {
    this.tokens = tokens;
    this.ids = ids;
    this.diags = diags;
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private get tok(): Token {
    return this.tokens[this.pos];
  }

  private peek(n = 1): Token {
    return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (t.kind !== "eof") this.pos++;
    return t;
  }

  /** Is the current token the punctuation or keyword `s`? */
  private is(s: string, t: Token = this.tok): boolean {
    return (t.kind === "punct" || t.kind === "keyword") && t.value === s;
  }

  private eat(s: string): boolean {
    if (this.is(s)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(s: string): Token {
    if (this.is(s)) return this.advance();
    this.fail(`expected \`${s}\`, found ${describe(this.tok)}`);
  }

  /**
   * Close a generic list. If the lexer glued the `>` to what follows (`Vec<u8>=`
   * lexes as `Vec < u8 >=`), split off one `>` and leave the rest as a new token.
   */
  private expectCloseAngle() {
    const t = this.tok;
    if (t.kind === "punct" && (t.value === ">=" || t.value === ">>=")) {
      const rest = String(t.value).slice(1);
      this.tokens[this.pos] = { ...t, text: rest, value: rest, span: { ...t.span, start: t.span.start + 1 } };
      return;
    }
    this.expect(">");
  }

  private expectIdent(what = "identifier"): Token {
    if (this.tok.kind === "ident") return this.advance();
    this.fail(`expected ${what}, found ${describe(this.tok)}`);
  }

  private fail(message: string, span: Span = this.tok.span): never {
    this.diags.error("parse", span, message);
    throw new ParseAbort(message);
  }

  /** The span from `start` up to the end of the previously consumed token. */
  private spanFrom(start: Span): Span {
    const prev = this.tokens[Math.max(0, this.pos - 1)];
    return joinSpans(start, prev.span);
  }

  private id(): number {
    return this.ids.fresh();
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /** Parse items until `close` (e.g. `}`) or end of file, recovering from errors. */
  parseItemsUntil(close: string | null): A.Item[] {
    const items: A.Item[] = [];
    // Skip inner attributes like `#![allow(dead_code)]`.
    while (this.is("#") && this.is("!", this.peek())) this.skipAttribute();
    while (this.tok.kind !== "eof" && !(close && this.is(close))) {
      const start = this.pos;
      try {
        items.push(this.parseItem());
      } catch (e) {
        if (!(e instanceof ParseAbort)) throw e;
        this.recoverToItem(start);
      }
    }
    return items;
  }

  /** Error recovery: skip tokens until something that looks like the start of an item. */
  private recoverToItem(start: number) {
    if (this.pos === start) this.advance();
    let depth = 0;
    while (this.tok.kind !== "eof") {
      if (this.is("{")) depth++;
      if (this.is("}")) {
        if (depth === 0) return;
        depth--;
        if (depth === 0) { this.advance(); return; }
      }
      if (depth === 0 && ["fn", "struct", "enum", "impl", "trait", "mod", "use", "pub", "const", "type"].some((k) => this.is(k))) return;
      this.advance();
    }
  }

  private skipAttribute() {
    this.expect("#");
    this.eat("!");
    this.expect("[");
    let depth = 1;
    while (depth > 0 && this.tok.kind !== "eof") {
      if (this.is("[")) depth++;
      if (this.is("]")) depth--;
      this.advance();
    }
  }

  /** Parse outer attributes, returning any `#[derive(...)]` trait names. */
  private parseAttributes(): string[] {
    const derives: string[] = [];
    while (this.is("#") && !this.is("!", this.peek())) {
      if (this.peek(2).value === "derive" && this.is("(", this.peek(3))) {
        this.pos += 4; // # [ derive (
        while (!this.is(")")) {
          derives.push(String(this.expectIdent("trait name").value));
          if (!this.eat(",")) break;
        }
        this.expect(")");
        this.expect("]");
      } else {
        this.skipAttribute();
      }
    }
    return derives;
  }

  parseItem(): A.Item {
    const derives = this.parseAttributes();
    const start = this.tok.span;
    const isPub = this.eat("pub");
    if (isPub && this.is("(")) {
      // `pub(crate)`: TSRust treats it like `pub`.
      while (!this.is(")")) this.advance();
      this.advance();
    }
    // Body-less functions are std intrinsics; name resolution rejects them elsewhere.
    if (this.is("fn")) return this.parseFn(start, isPub, false);
    if (this.is("struct")) return this.parseStruct(start, isPub, derives);
    if (this.is("enum")) return this.parseEnum(start, isPub, derives);
    if (this.is("impl")) return this.parseImpl(start);
    if (this.is("trait")) return this.parseTrait(start, isPub);
    if (this.is("mod")) return this.parseMod(start, isPub);
    if (this.is("use")) return this.parseUse(start, isPub);
    if (this.is("const")) return this.parseConst(start, isPub);
    if (this.is("type")) return this.parseTypeAlias(start, isPub);
    this.fail(`expected item, found ${describe(this.tok)}`);
  }

  private parseGenerics(): A.Generics {
    const generics: A.Generics = { lifetimes: [], params: [] };
    if (!this.eat("<")) return generics;
    while (!this.is(">")) {
      if (this.tok.kind === "lifetime") {
        generics.lifetimes.push(String(this.advance().value));
        // Lifetime bounds like `'a: 'b` are accepted and ignored.
        if (this.eat(":")) while (this.tok.kind === "lifetime" || this.is("+")) this.advance();
      } else {
        const name = this.expectIdent("generic parameter");
        const bounds = this.eat(":") ? this.parseBounds() : [];
        const def = this.eat("=") ? this.parseType() : undefined;
        generics.params.push({ name: String(name.value), bounds, default: def, span: name.span });
      }
      if (!this.eat(",")) break;
    }
    this.expectCloseAngle();
    return generics;
  }

  /** `Display + Clone + 'a` */
  private parseBounds(): A.Path[] {
    const bounds: A.Path[] = [];
    do {
      if (this.tok.kind === "lifetime") { this.advance(); continue; }
      // `?Sized` relaxes an implicit bound TSRust doesn't model; skip it.
      if (this.eat("?")) { this.parsePath("type"); continue; }
      bounds.push(this.parsePath("type"));
    } while (this.eat("+"));
    return bounds;
  }

  /** `where T: Display, U: Clone` — merged into the matching generic params. */
  private parseWhere(generics: A.Generics) {
    if (!this.eat("where")) return;
    while (this.tok.kind === "ident") {
      const name = this.advance();
      this.expect(":");
      const bounds = this.parseBounds();
      const param = generics.params.find((p) => p.name === name.value);
      if (param) param.bounds.push(...bounds);
      else this.diags.error("parse", name.span, `\`where\` clause for unknown type parameter \`${name.value}\``);
      if (!this.eat(",")) break;
    }
  }

  private parseFn(start: Span, isPub: boolean, requireBody: boolean): A.FnItem {
    this.expect("fn");
    const name = this.expectIdent("function name");
    const generics = this.parseGenerics();
    this.expect("(");
    let selfParam: A.FnItem["selfParam"];
    const params: A.Param[] = [];
    // `self`, `mut self`, `&self`, `&mut self`, `&'a self`
    const selfStart = this.tok.span;
    if (this.is("self") || (this.is("mut") && this.is("self", this.peek()))) {
      const mutable = this.eat("mut");
      this.advance();
      selfParam = { id: this.id(), kind: "value", mutable, span: this.spanFrom(selfStart) };
      if (this.eat(":")) this.parseType(); // `self: Self` style; accepted, ignored
    } else if (this.is("&")) {
      let n = 1;
      if (this.peek(n).kind === "lifetime") n++;
      const isMut = this.is("mut", this.peek(n));
      if (isMut) n++;
      if (this.is("self", this.peek(n))) {
        this.pos += n + 1;
        selfParam = { id: this.id(), kind: isMut ? "refMut" : "ref", mutable: false, span: this.spanFrom(selfStart) };
      }
    }
    if (selfParam && !this.is(")")) this.expect(",");
    while (!this.is(")")) {
      const pStart = this.tok.span;
      const pat = this.parsePattern();
      this.expect(":");
      const ty = this.parseType();
      params.push({ id: this.id(), pat, ty, span: this.spanFrom(pStart) });
      if (!this.eat(",")) break;
    }
    this.expect(")");
    const ret = this.eat("->") ? this.parseType() : undefined;
    this.parseWhere(generics);
    let body: A.BlockExpr | undefined;
    if (this.is("{")) body = this.parseBlock();
    else if (requireBody) this.fail(`expected \`{\` to start the body of \`${name.value}\``);
    else this.expect(";");
    return {
      kind: "fn", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span,
      isPub, generics, selfParam, params, ret, body,
    };
  }

  /** Field lists shared by structs and enum variants: `{ a: T, b: U }` or `(T, U)` or nothing. */
  private parseFields(): { fieldsKind: A.FieldsKind; fields: A.FieldDef[] } {
    const fields: A.FieldDef[] = [];
    if (this.eat("{")) {
      while (!this.is("}")) {
        this.parseAttributes();
        const fStart = this.tok.span;
        const isPub = this.eat("pub");
        const name = this.expectIdent("field name");
        this.expect(":");
        const ty = this.parseType();
        fields.push({ name: String(name.value), ty, isPub, span: this.spanFrom(fStart) });
        if (!this.eat(",")) break;
      }
      this.expect("}");
      return { fieldsKind: "named", fields };
    }
    if (this.eat("(")) {
      while (!this.is(")")) {
        const fStart = this.tok.span;
        const isPub = this.eat("pub");
        const ty = this.parseType();
        fields.push({ name: String(fields.length), ty, isPub, span: this.spanFrom(fStart) });
        if (!this.eat(",")) break;
      }
      this.expect(")");
      return { fieldsKind: "tuple", fields };
    }
    return { fieldsKind: "unit", fields };
  }

  private parseStruct(start: Span, isPub: boolean, derives: string[]): A.StructItem {
    this.expect("struct");
    const name = this.expectIdent("struct name");
    const generics = this.parseGenerics();
    this.parseWhere(generics);
    const { fieldsKind, fields } = this.parseFields();
    if (fieldsKind !== "named") this.expect(";");
    return { kind: "struct", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span, isPub, generics, fieldsKind, fields, derives };
  }

  private parseEnum(start: Span, isPub: boolean, derives: string[]): A.EnumItem {
    this.expect("enum");
    const name = this.expectIdent("enum name");
    const generics = this.parseGenerics();
    this.parseWhere(generics);
    this.expect("{");
    const variants: A.Variant[] = [];
    while (!this.is("}")) {
      this.parseAttributes();
      const vName = this.expectIdent("variant name");
      const { fieldsKind, fields } = this.parseFields();
      variants.push({ name: String(vName.value), fieldsKind, fields, span: this.spanFrom(vName.span) });
      if (!this.eat(",")) break;
    }
    this.expect("}");
    return { kind: "enum", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span, isPub, generics, variants, derives };
  }

  private parseImpl(start: Span): A.ImplItem {
    this.expect("impl");
    const generics = this.is("<") ? this.parseGenerics() : { lifetimes: [], params: [] };
    const first = this.parseType();
    let traitPath: A.Path | undefined;
    let selfTy = first;
    if (this.eat("for")) {
      if (first.kind !== "path") this.fail("expected a trait name before `for`", first.span);
      traitPath = first.path;
      selfTy = this.parseType();
    }
    this.parseWhere(generics);
    this.expect("{");
    const items: A.FnItem[] = [];
    const assocTypes: A.TypeAliasItem[] = [];
    const consts: A.ConstItem[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      this.parseAttributes();
      const iStart = this.tok.span;
      const isPub = this.eat("pub");
      if (this.is("type")) assocTypes.push(this.parseTypeAlias(iStart, isPub));
      else if (this.is("const")) consts.push(this.parseConst(iStart, isPub));
      // Bodies are optional here so the standard library can declare
      // *intrinsics*: functions implemented natively by the VM. Name resolution
      // rejects body-less functions outside of `std`.
      else items.push(this.parseFn(iStart, isPub, false));
    }
    this.expect("}");
    return { kind: "impl", id: this.id(), span: this.spanFrom(start), generics, traitPath, selfTy, items, assocTypes, consts };
  }

  private parseTrait(start: Span, isPub: boolean): A.TraitItem {
    this.expect("trait");
    const name = this.expectIdent("trait name");
    const generics = this.parseGenerics();
    const supertraits = this.eat(":") ? this.parseBounds() : [];
    this.parseWhere(generics);
    this.expect("{");
    const items: A.FnItem[] = [];
    const assocTypes: A.TypeAliasItem[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      this.parseAttributes();
      if (this.is("type")) assocTypes.push(this.parseTypeAlias(this.tok.span, true));
      else items.push(this.parseFn(this.tok.span, true, false));
    }
    this.expect("}");
    return { kind: "trait", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span, isPub, generics, supertraits, items, assocTypes };
  }

  private parseMod(start: Span, isPub: boolean): A.ModItem {
    this.expect("mod");
    const name = this.expectIdent("module name");
    let items: A.Item[] | undefined;
    if (this.eat("{")) {
      items = this.parseItemsUntil("}");
      this.expect("}");
    } else {
      this.expect(";");
    }
    return { kind: "mod", id: this.id(), span: this.spanFrom(start), name: String(name.value), isPub, items };
  }

  private parseUse(start: Span, isPub: boolean): A.UseItem {
    this.expect("use");
    const tree = this.parseUseTree();
    this.expect(";");
    return { kind: "use", id: this.id(), span: this.spanFrom(start), isPub, tree };
  }

  private parseUseTree(): A.UseTree {
    const start = this.tok.span;
    const path: string[] = [];
    while (true) {
      if (this.eat("*")) return { kind: "glob", path, span: this.spanFrom(start) };
      if (this.eat("{")) {
        const trees: A.UseTree[] = [];
        while (!this.is("}")) {
          trees.push(this.parseUseTree());
          if (!this.eat(",")) break;
        }
        this.expect("}");
        return { kind: "nested", path, trees, span: this.spanFrom(start) };
      }
      const seg = this.tok;
      if (seg.kind === "ident" || this.is("self") || this.is("super") || this.is("crate") || this.is("Self")) {
        this.advance();
        path.push(String(seg.value));
      } else {
        this.fail(`expected identifier in \`use\` path, found ${describe(seg)}`);
      }
      if (!this.eat("::")) break;
    }
    const alias = this.eat("as") ? String(this.expectIdent("alias").value) : undefined;
    return { kind: "simple", path, alias, span: this.spanFrom(start) };
  }

  private parseTypeAlias(start: Span, isPub: boolean): A.TypeAliasItem {
    this.expect("type");
    const name = this.expectIdent("type name");
    const generics = this.parseGenerics();
    // Bounds on associated types (`type Item: Clone;`) are accepted and ignored.
    if (this.eat(":")) this.parseBounds();
    const ty = this.eat("=") ? this.parseType() : undefined;
    this.expect(";");
    return { kind: "type", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span, isPub, generics, ty };
  }

  private parseConst(start: Span, isPub: boolean): A.ConstItem {
    this.expect("const");
    const name = this.expectIdent("constant name");
    this.expect(":");
    const ty = this.parseType();
    this.expect("=");
    const value = this.parseExpr();
    this.expect(";");
    return { kind: "const", id: this.id(), span: this.spanFrom(start), name: String(name.value), nameSpan: name.span, isPub, ty, value };
  }

  // -------------------------------------------------------------------------
  // Paths and types
  // -------------------------------------------------------------------------

  /**
   * Parse `a::b::c`. In `"type"` mode `<` after a segment opens generic args;
   * in `"expr"` mode generics need the turbofish `::<`.
   */
  private parsePath(mode: "type" | "expr"): A.Path {
    const start = this.tok.span;
    const segments: A.PathSegment[] = [];
    while (true) {
      const t = this.tok;
      if (!(t.kind === "ident" || this.is("self") || this.is("Self") || this.is("super") || this.is("crate"))) {
        this.fail(`expected identifier, found ${describe(t)}`);
      }
      this.advance();
      const seg: A.PathSegment = { name: String(t.value), span: t.span };
      segments.push(seg);
      if (mode === "type" && this.is("<")) {
        const { args, bindings, lifetimes } = this.parseGenericArgsWithBindings();
        seg.generics = args;
        if (bindings.length) seg.bindings = bindings;
        if (lifetimes.length) seg.lifetimes = lifetimes;
      }
      if (this.is("::")) {
        if (this.is("<", this.peek())) {
          this.advance();
          seg.generics = this.parseGenericArgs();
          if (!this.eat("::")) break;
          continue;
        }
        this.advance();
        continue;
      }
      break;
    }
    return { id: this.id(), span: this.spanFrom(start), segments };
  }

  private parseGenericArgs(): A.TypeExpr[] {
    const { args, bindings } = this.parseGenericArgsWithBindings();
    if (bindings.length) this.diags.error("parse", bindings[0].span, "associated type bindings are only allowed in trait bounds");
    return args;
  }

  /** `<T, U>` or, in bounds, `<Item = T>`. Lifetime arguments are skipped. */
  private parseGenericArgsWithBindings(): { args: A.TypeExpr[]; bindings: { name: string; ty: A.TypeExpr; span: Span }[]; lifetimes: string[] } {
    this.expect("<");
    const args: A.TypeExpr[] = [];
    const lifetimes: string[] = [];
    const bindings: { name: string; ty: A.TypeExpr; span: Span }[] = [];
    while (!this.is(">")) {
      if (this.tok.kind === "lifetime") { lifetimes.push(String(this.advance().value)); }
      else if (this.tok.kind === "ident" && this.is("=", this.peek())) {
        const name = this.advance();
        this.advance();
        const ty = this.parseType();
        bindings.push({ name: String(name.value), ty, span: this.spanFrom(name.span) });
      }
      else args.push(this.parseType());
      if (!this.eat(",")) break;
    }
    this.expectCloseAngle();
    return { args, bindings, lifetimes };
  }

  parseType(): A.TypeExpr {
    const start = this.tok.span;
    if (this.eat("&")) {
      const lifetime = this.tok.kind === "lifetime" ? String(this.advance().value) : undefined;
      const mutable = this.eat("mut");
      const inner = this.parseType();
      return { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable, lifetime, inner };
    }
    if (this.is("&&")) {
      // `&&T` is lexed as one token; split it into two references.
      this.advance();
      const mutable = this.eat("mut");
      const inner = this.parseType();
      const innerRef: A.TypeExpr = { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable, inner };
      return { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable: false, inner: innerRef };
    }
    if (this.eat("(")) {
      const elems: A.TypeExpr[] = [];
      while (!this.is(")")) {
        elems.push(this.parseType());
        if (!this.eat(",")) {
          if (elems.length === 1 && this.is(")")) {
            this.advance();
            return elems[0]; // `(T)` is just `T`
          }
          break;
        }
      }
      this.expect(")");
      return { kind: "tuple", id: this.id(), span: this.spanFrom(start), elems };
    }
    if (this.eat("!")) return { kind: "never", id: this.id(), span: this.spanFrom(start) };
    if (this.tok.kind === "ident" && this.tok.value === "_") {
      this.advance();
      return { kind: "infer", id: this.id(), span: this.spanFrom(start) };
    }
    if (this.eat("<")) {
      // Qualified path: `<T as Trait>::Name`
      const self = this.parseType();
      this.expect("as");
      const trait = this.parsePath("type");
      this.expect(">");
      this.expect("::");
      const name = String(this.expectIdent("associated type name").value);
      return { kind: "qpath", id: this.id(), span: this.spanFrom(start), self, trait, name };
    }
    if (this.is("[")) this.fail("arrays and slices are not supported by TSRust yet; use `Vec<T>`");
    if (this.is("fn") || this.is("impl") || (this.tok.kind === "ident" && this.tok.value === "dyn")) {
      this.fail(`\`${this.tok.value}\` types are not supported by TSRust yet`);
    }
    const path = this.parsePath("type");
    return { kind: "path", id: this.id(), span: path.span, path };
  }

  // -------------------------------------------------------------------------
  // Patterns
  // -------------------------------------------------------------------------

  parsePattern(): A.Pattern {
    const start = this.tok.span;
    this.eat("|"); // leading `|` is allowed in match arms
    const first = this.parsePatternAtom();
    if (!this.is("|")) return first;
    const alts = [first];
    while (this.eat("|")) alts.push(this.parsePatternAtom());
    return { kind: "or", id: this.id(), span: this.spanFrom(start), alts };
  }

  private literalFromToken(t: Token): A.Literal | undefined {
    switch (t.kind) {
      case "int": return { kind: "int", value: t.value as number, suffix: t.suffix };
      case "float": return { kind: "float", value: t.value as number, suffix: t.suffix };
      case "string": return { kind: "str", value: t.value as string };
      case "char": return { kind: "char", value: t.value as string };
      case "keyword":
        if (t.value === "true" || t.value === "false") return { kind: "bool", value: t.value === "true" };
    }
    return undefined;
  }

  private parsePatternAtom(): A.Pattern {
    const start = this.tok.span;
    const t = this.tok;
    if (t.kind === "ident" && t.value === "_") {
      this.advance();
      return { kind: "wild", id: this.id(), span: t.span };
    }
    if (this.is("&") || this.is("&&")) {
      const double = this.is("&&");
      this.advance();
      const mutable = this.eat("mut");
      let inner = this.parsePatternAtom();
      if (double) inner = { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable, inner };
      return { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable: double ? false : mutable, inner };
    }
    if (this.eat("(")) {
      const elems: A.Pattern[] = [];
      while (!this.is(")")) {
        elems.push(this.parsePattern());
        if (!this.eat(",")) {
          if (elems.length === 1 && this.is(")")) { this.advance(); return elems[0]; }
          break;
        }
      }
      this.expect(")");
      return { kind: "tuple", id: this.id(), span: this.spanFrom(start), elems };
    }
    // Literal patterns, optionally negative, optionally the start of a range.
    const negative = this.is("-") && (this.peek().kind === "int" || this.peek().kind === "float");
    if (negative) this.advance();
    const lit = this.literalFromToken(this.tok);
    if (lit) {
      this.advance();
      if (negative && (lit.kind === "int" || lit.kind === "float")) lit.value = -lit.value;
      if (this.is("..=") || this.is("...") || this.is("..")) {
        const inclusive = !this.is("..");
        this.advance();
        const hiNeg = this.eat("-");
        const hi = this.literalFromToken(this.advance());
        if (!hi) this.fail("expected literal at end of range pattern");
        if (hiNeg && (hi.kind === "int" || hi.kind === "float")) hi.value = -hi.value;
        return { kind: "range", id: this.id(), span: this.spanFrom(start), lo: lit, hi, inclusive };
      }
      return { kind: "lit", id: this.id(), span: this.spanFrom(start), value: lit, negative };
    }
    // `ref x`, `mut x`, `ref mut x`, `x @ pat`
    if (this.is("ref") || this.is("mut")) {
      const byRef = this.eat("ref");
      const mutable = this.eat("mut");
      const name = this.expectIdent("binding name");
      const sub = this.eat("@") ? this.parsePatternAtom() : undefined;
      return { kind: "ident", id: this.id(), span: this.spanFrom(start), name: String(name.value), mutable, byRef, sub };
    }
    if (t.kind === "ident" || this.is("Self") || this.is("crate") || this.is("super") || this.is("self")) {
      // A lone identifier is a *binding*, unless name resolution later finds it
      // names a unit variant or constant (like `None`). That's rustc's rule too.
      const single = t.kind === "ident" && !this.is("::", this.peek()) && !this.is("(", this.peek()) && !this.is("{", this.peek());
      if (single) {
        this.advance();
        const sub = this.eat("@") ? this.parsePatternAtom() : undefined;
        return { kind: "ident", id: this.id(), span: this.spanFrom(start), name: String(t.value), mutable: false, byRef: false, sub };
      }
      const path = this.parsePath("expr");
      if (this.eat("(")) {
        const elems: A.Pattern[] = [];
        while (!this.is(")")) {
          elems.push(this.parsePattern());
          if (!this.eat(",")) break;
        }
        this.expect(")");
        return { kind: "tupleStruct", id: this.id(), span: this.spanFrom(start), path, elems };
      }
      if (this.eat("{")) {
        const fields: { name: string; pat: A.Pattern; span: Span }[] = [];
        let rest = false;
        while (!this.is("}")) {
          if (this.eat("..")) { rest = true; break; }
          const fStart = this.tok.span;
          // Shorthand `Point { x, ref mut y }`.
          const byRef = this.eat("ref");
          const mutable = this.eat("mut");
          const fname = this.expectIdent("field name");
          let pat: A.Pattern;
          if (!byRef && !mutable && this.eat(":")) pat = this.parsePattern();
          else pat = { kind: "ident", id: this.id(), span: fname.span, name: String(fname.value), mutable, byRef };
          fields.push({ name: String(fname.value), pat, span: this.spanFrom(fStart) });
          if (!this.eat(",")) break;
        }
        this.expect("}");
        return { kind: "struct", id: this.id(), span: this.spanFrom(start), path, fields, rest };
      }
      return { kind: "path", id: this.id(), span: path.span, path };
    }
    this.fail(`expected pattern, found ${describe(t)}`);
  }

  // -------------------------------------------------------------------------
  // Blocks and statements
  // -------------------------------------------------------------------------

  parseBlock(): A.BlockExpr {
    const start = this.expect("{").span;
    const stmts: A.Stmt[] = [];
    let tail: A.Expr | undefined;
    while (!this.is("}") && this.tok.kind !== "eof") {
      if (this.eat(";")) continue;
      const before = this.pos;
      try {
        const stmt = this.parseStmt();
        if (stmt.kind === "expr" && !stmt.semi && this.is("}")) {
          tail = stmt.expr;
        } else {
          stmts.push(stmt);
        }
      } catch (e) {
        if (!(e instanceof ParseAbort)) throw e;
        this.recoverInBlock(before);
      }
    }
    this.expect("}");
    return { kind: "block", id: this.id(), span: this.spanFrom(start), stmts, tail };
  }

  /** Error recovery inside a block: skip to the next `;` or the closing `}`. */
  private recoverInBlock(start: number) {
    if (this.pos === start) this.advance();
    let depth = 0;
    while (this.tok.kind !== "eof") {
      if (this.is("{") || this.is("(") || this.is("[")) depth++;
      else if (this.is("}") || this.is(")") || this.is("]")) {
        if (depth === 0) return;
        depth--;
      } else if (this.is(";") && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  private isItemStart(): boolean {
    if (this.is("#")) return true;
    if (["fn", "struct", "enum", "impl", "trait", "mod", "use", "pub", "type"].some((k) => this.is(k))) return true;
    return this.is("const") && this.peek().kind === "ident";
  }

  parseStmt(): A.Stmt {
    const start = this.tok.span;
    if (this.isItemStart()) {
      const item = this.parseItem();
      return { kind: "item", id: this.id(), span: item.span, item };
    }
    if (this.eat("let")) {
      const pat = this.parsePattern();
      const ty = this.eat(":") ? this.parseType() : undefined;
      const init = this.eat("=") ? this.parseExpr() : undefined;
      if (this.is("else")) this.fail("`let ... else` is not supported by TSRust yet");
      this.expect(";");
      return { kind: "let", id: this.id(), span: this.spanFrom(start), pat, ty, init };
    }
    const expr = this.parseExprStmt();
    let semi = this.eat(";");
    // Block-like expressions (`if`, `match`, `loop` ...) end a statement on
    // their own; anything else needs a `;` unless it is the block's tail.
    if (!semi && !this.is("}") && !isBlockLike(expr)) {
      this.fail(`expected \`;\`, found ${describe(this.tok)}`);
    }
    if (!semi && isBlockLike(expr) && !this.is("}")) semi = false;
    return { kind: "expr", id: this.id(), span: this.spanFrom(start), expr, semi };
  }

  /** At statement start, a block-like expression is complete on its own (`if a {} -1` is two statements). */
  private parseExprStmt(): A.Expr {
    if (this.is("{") || this.is("if") || this.is("match") || this.is("loop") || this.is("while") || this.is("for") ||
        (this.tok.kind === "lifetime" && this.is(":", this.peek()))) {
      let e = this.parsePrimary(false);
      // ...but method calls may still be chained: `match x { .. }.unwrap()`.
      if (this.is(".") || this.is("?")) {
        e = this.parsePostfixOps(e, false);
        return this.parseBinaryRest(e, 0, false);
      }
      return e;
    }
    return this.parseExpr();
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  parseExpr(noStruct = false): A.Expr {
    return this.parseAssign(noStruct);
  }

  private parseAssign(noStruct: boolean): A.Expr {
    const start = this.tok.span;
    const target = this.parseRange(noStruct);
    if (this.tok.kind === "punct" && ASSIGN_OPS.has(String(this.tok.value))) {
      const op = String(this.advance().value) as A.AssignOp;
      const value = this.parseAssign(noStruct); // right associative
      return { kind: "assign", id: this.id(), span: this.spanFrom(start), op, target, value };
    }
    return target;
  }

  private canStartExpr(noStruct: boolean): boolean {
    const t = this.tok;
    if (t.kind === "eof") return false;
    if (t.kind === "punct") return ["(", "-", "!", "*", "&", "&&", "|"].includes(String(t.value)) || (t.value === "{" && !noStruct) || t.value === "..";
    if (t.kind === "keyword") return !["as", "else", "in"].includes(String(t.value));
    return true;
  }

  private parseRange(noStruct: boolean): A.Expr {
    const start = this.tok.span;
    if (this.is("..") || this.is("..=")) {
      const inclusive = this.advance().value === "..=";
      const end = this.canStartExpr(noStruct) ? this.parseBinary(3, noStruct) : undefined;
      return { kind: "range", id: this.id(), span: this.spanFrom(start), end, inclusive };
    }
    const lhs = this.parseBinary(3, noStruct);
    if (this.is("..") || this.is("..=")) {
      const inclusive = this.advance().value === "..=";
      const end = this.canStartExpr(noStruct) ? this.parseBinary(3, noStruct) : undefined;
      return { kind: "range", id: this.id(), span: this.spanFrom(start), start: lhs, end, inclusive };
    }
    return lhs;
  }

  /** Read the binary operator at the cursor, gluing joint `>` `>` / `<` `<` into shifts. */
  private peekBinaryOp(): { op: string; width: number } | undefined {
    const t = this.tok;
    if (t.kind === "keyword" && t.value === "as") return { op: "as", width: 1 };
    if (t.kind !== "punct") return undefined;
    const v = String(t.value);
    if ((v === ">" || v === "<") && t.joint && this.is(v, this.peek())) return { op: v + v, width: 2 };
    if (v in BINARY_PRECEDENCE) return { op: v, width: 1 };
    return undefined;
  }

  private parseBinary(minPrec: number, noStruct: boolean): A.Expr {
    return this.parseBinaryRest(this.parseUnary(noStruct), minPrec, noStruct);
  }

  /**
   * Precedence climbing: having parsed `left`, keep absorbing operators whose
   * precedence is at least `minPrec`. The right operand is parsed with
   * `prec + 1`, which makes operators left-associative.
   */
  private parseBinaryRest(left: A.Expr, minPrec: number, noStruct: boolean): A.Expr {
    while (true) {
      const op = this.peekBinaryOp();
      if (!op) return left;
      const prec = op.op === "as" ? AS_PRECEDENCE : BINARY_PRECEDENCE[op.op];
      if (prec < minPrec) return left;
      this.pos += op.width;
      if (op.op === "as") {
        const ty = this.parseType();
        left = { kind: "cast", id: this.id(), span: joinSpans(left.span, ty.span), expr: left, ty };
        continue;
      }
      const right = this.parseBinary(prec + 1, noStruct);
      left = { kind: "binary", id: this.id(), span: joinSpans(left.span, right.span), op: op.op as A.BinaryOp, left, right };
      // Comparisons are non-associative: `a < b < c` is an error in Rust.
      if (prec === 5 && this.peekBinaryOp() && BINARY_PRECEDENCE[this.peekBinaryOp()!.op] === 5) {
        this.fail("comparison operators cannot be chained");
      }
    }
  }

  private parseUnary(noStruct: boolean): A.Expr {
    const start = this.tok.span;
    if (this.is("-") || this.is("!") || this.is("*")) {
      const op = String(this.advance().value) as "-" | "!" | "*";
      const expr = this.parseUnary(noStruct);
      return { kind: "unary", id: this.id(), span: this.spanFrom(start), op, expr };
    }
    if (this.is("&") || this.is("&&")) {
      const double = this.is("&&");
      this.advance();
      const mutable = this.eat("mut");
      const expr = this.parseUnary(noStruct);
      const inner: A.Expr = { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable, expr };
      if (!double) return inner;
      return { kind: "ref", id: this.id(), span: this.spanFrom(start), mutable: false, expr: inner };
    }
    if (this.is("|") || this.is("||") || this.is("move")) {
      this.fail("closures are not supported by TSRust yet");
    }
    return this.parsePostfixOps(this.parsePrimary(noStruct), noStruct);
  }

  private parseCallArgs(): A.Expr[] {
    this.expect("(");
    const args: A.Expr[] = [];
    while (!this.is(")")) {
      args.push(this.parseExpr());
      if (!this.eat(",")) break;
    }
    this.expect(")");
    return args;
  }

  private parsePostfixOps(expr: A.Expr, _noStruct: boolean): A.Expr {
    while (true) {
      const start = expr.span;
      if (this.is("?")) {
        this.advance();
        expr = { kind: "try", id: this.id(), span: this.spanFrom(start), expr };
      } else if (this.is("(")) {
        const args = this.parseCallArgs();
        expr = { kind: "call", id: this.id(), span: this.spanFrom(start), callee: expr, args };
      } else if (this.is("[")) {
        this.advance();
        const index = this.parseExpr();
        this.expect("]");
        expr = { kind: "index", id: this.id(), span: this.spanFrom(start), expr, index };
      } else if (this.is(".")) {
        this.advance();
        const t = this.tok;
        if (t.kind === "int") {
          // Tuple field: `pair.0`
          this.advance();
          expr = { kind: "field", id: this.id(), span: this.spanFrom(start), expr, name: String(t.value), nameSpan: t.span };
        } else if (t.kind === "float" && /^\d+\.\d+$/.test(t.text)) {
          // `nested.0.1` lexes `0.1` as a float. Split it back into two fields.
          this.advance();
          const [a, b] = t.text.split(".");
          const first: A.Expr = { kind: "field", id: this.id(), span: this.spanFrom(start), expr, name: a, nameSpan: t.span };
          expr = { kind: "field", id: this.id(), span: this.spanFrom(start), expr: first, name: b, nameSpan: t.span };
        } else {
          const name = this.expectIdent("field or method name");
          let generics: A.TypeExpr[] | undefined;
          if (this.is("::")) {
            this.advance();
            generics = this.parseGenericArgs();
          }
          if (this.is("(")) {
            const args = this.parseCallArgs();
            expr = { kind: "methodCall", id: this.id(), span: this.spanFrom(start), receiver: expr, method: String(name.value), methodSpan: name.span, generics, args };
          } else {
            expr = { kind: "field", id: this.id(), span: this.spanFrom(start), expr, name: String(name.value), nameSpan: name.span };
          }
        }
      } else {
        return expr;
      }
    }
  }

  private parsePrimary(noStruct: boolean): A.Expr {
    const t = this.tok;
    const start = t.span;
    const lit = this.literalFromToken(t);
    if (lit) {
      this.advance();
      return { kind: "lit", id: this.id(), span: t.span, value: lit };
    }
    if (t.kind === "lifetime" && this.is(":", this.peek())) {
      const label = String(t.value);
      this.advance();
      this.advance();
      const loop = this.parsePrimary(noStruct);
      if (loop.kind !== "loop" && loop.kind !== "while" && loop.kind !== "for") this.fail("labels are only allowed on loops", start);
      loop.label = label;
      if (loop.kind === "loop" && loop.body.tail === undefined) {
        // `while let` desugars to `loop`; propagate the label into its synthesized `break`.
        relabelBreaks(loop.body, label);
      }
      return loop;
    }
    if (this.is("(")) {
      this.advance();
      const elems: A.Expr[] = [];
      let trailingComma = false;
      while (!this.is(")")) {
        elems.push(this.parseExpr());
        trailingComma = false;
        if (!this.eat(",")) break;
        trailingComma = true;
      }
      this.expect(")");
      if (elems.length === 1 && !trailingComma) return elems[0];
      return { kind: "tuple", id: this.id(), span: this.spanFrom(start), elems };
    }
    if (this.is("{")) return this.parseBlock();
    if (this.is("if")) return this.parseIf();
    if (this.eat("match")) {
      const scrutinee = this.parseExpr(true);
      this.expect("{");
      const arms: A.MatchArm[] = [];
      while (!this.is("}")) {
        const aStart = this.tok.span;
        const pat = this.parsePattern();
        const guard = this.eat("if") ? this.parseExpr() : undefined;
        this.expect("=>");
        const body = this.parseExprStmt();
        arms.push({ pat, guard, body, span: this.spanFrom(aStart) });
        // A comma is required after non-block arms, except the last.
        if (!this.eat(",") && !this.is("}") && !isBlockLike(body)) this.fail(`expected \`,\` after match arm, found ${describe(this.tok)}`);
      }
      this.expect("}");
      return { kind: "match", id: this.id(), span: this.spanFrom(start), scrutinee, arms, source: "match" };
    }
    if (this.eat("loop")) {
      const body = this.parseBlock();
      return { kind: "loop", id: this.id(), span: this.spanFrom(start), body };
    }
    if (this.eat("while")) {
      if (this.eat("let")) return this.parseWhileLet(start);
      const cond = this.parseExpr(true);
      const body = this.parseBlock();
      return { kind: "while", id: this.id(), span: this.spanFrom(start), cond, body };
    }
    if (this.eat("for")) {
      const pat = this.parsePattern();
      this.expect("in");
      const iter = this.parseExpr(true);
      const body = this.parseBlock();
      return { kind: "for", id: this.id(), span: this.spanFrom(start), pat, iter, body };
    }
    if (this.eat("break")) {
      const label = this.tok.kind === "lifetime" ? String(this.advance().value) : undefined;
      const value = this.canStartExpr(noStruct) && !this.is("}") ? this.parseExpr(noStruct) : undefined;
      return { kind: "break", id: this.id(), span: this.spanFrom(start), label, value };
    }
    if (this.eat("continue")) {
      const label = this.tok.kind === "lifetime" ? String(this.advance().value) : undefined;
      return { kind: "continue", id: this.id(), span: this.spanFrom(start), label };
    }
    if (this.eat("return")) {
      const value = this.canStartExpr(noStruct) && !this.is("}") ? this.parseExpr(noStruct) : undefined;
      return { kind: "return", id: this.id(), span: this.spanFrom(start), value };
    }
    if (t.kind === "ident" && this.is("!", this.peek()) && (this.is("(", this.peek(2)) || this.is("[", this.peek(2)) || this.is("{", this.peek(2)))) {
      return this.parseMacro();
    }
    if (t.kind === "ident" || this.is("self") || this.is("Self") || this.is("crate") || this.is("super")) {
      const path = this.parsePath("expr");
      if (this.is("{") && !noStruct && this.looksLikeStructLit()) return this.parseStructLit(path);
      return { kind: "path", id: this.id(), span: path.span, path };
    }
    this.fail(`expected expression, found ${describe(t)}`);
  }

  /** After `Path {`, is this a struct literal? Look for `}` or `ident :` or `ident ,` or `..`. */
  private looksLikeStructLit(): boolean {
    const a = this.peek(1);
    const b = this.peek(2);
    if (this.is("}", a)) return true;
    if (this.is("..", a)) return true;
    return a.kind === "ident" && (this.is(":", b) || this.is(",", b) || this.is("}", b));
  }

  private parseStructLit(path: A.Path): A.Expr {
    this.expect("{");
    const fields: { name: string; value: A.Expr; span: Span }[] = [];
    let base: A.Expr | undefined;
    while (!this.is("}")) {
      if (this.eat("..")) { base = this.parseExpr(); break; }
      const name = this.expectIdent("field name");
      let value: A.Expr;
      if (this.eat(":")) value = this.parseExpr();
      else {
        // Field init shorthand: `Point { x, y }` means `Point { x: x, y: y }`.
        const p: A.Path = { id: this.id(), span: name.span, segments: [{ name: String(name.value), span: name.span }] };
        value = { kind: "path", id: this.id(), span: name.span, path: p };
      }
      fields.push({ name: String(name.value), value, span: this.spanFrom(name.span) });
      if (!this.eat(",")) break;
    }
    this.expect("}");
    return { kind: "structLit", id: this.id(), span: this.spanFrom(path.span), path, fields, base };
  }

  private parseIf(): A.Expr {
    const start = this.expect("if").span;
    if (this.eat("let")) {
      // Desugar `if let P = e { a } else { b }` into a match.
      const pat = this.parsePattern();
      this.expect("=");
      const scrutinee = this.parseExpr(true);
      const then = this.parseBlock();
      const elseExpr = this.parseElse();
      const fallback: A.Expr = elseExpr ?? this.emptyBlock(then.span);
      const wild: A.Pattern = { kind: "wild", id: this.id(), span: pat.span };
      return {
        kind: "match", id: this.id(), span: this.spanFrom(start), scrutinee, source: "if let",
        arms: [{ pat, body: then, span: then.span }, { pat: wild, body: fallback, span: fallback.span }],
      };
    }
    const cond = this.parseExpr(true);
    const then = this.parseBlock();
    const elseExpr = this.parseElse();
    return { kind: "if", id: this.id(), span: this.spanFrom(start), cond, then, else: elseExpr };
  }

  private parseElse(): A.Expr | undefined {
    if (!this.eat("else")) return undefined;
    if (this.is("if")) return this.parseIf();
    return this.parseBlock();
  }

  private emptyBlock(span: Span): A.BlockExpr {
    return { kind: "block", id: this.id(), span, stmts: [] };
  }

  private parseWhileLet(start: Span): A.Expr {
    // Desugar `while let P = e { body }` into `loop { match e { P => body, _ => break } }`.
    const pat = this.parsePattern();
    this.expect("=");
    const scrutinee = this.parseExpr(true);
    const body = this.parseBlock();
    const brk: A.Expr = { kind: "break", id: this.id(), span: scrutinee.span };
    const wild: A.Pattern = { kind: "wild", id: this.id(), span: pat.span };
    const match: A.Expr = {
      kind: "match", id: this.id(), span: this.spanFrom(start), scrutinee, source: "while let",
      arms: [{ pat, body, span: body.span }, { pat: wild, body: brk, span: brk.span }],
    };
    const loopBody: A.BlockExpr = { kind: "block", id: this.id(), span: body.span, stmts: [{ kind: "expr", id: this.id(), span: match.span, expr: match, semi: true }] };
    return { kind: "loop", id: this.id(), span: this.spanFrom(start), body: loopBody };
  }

  /**
   * Built-in macros. Real Rust macros operate on token trees and are expanded
   * before parsing completes. TSRust only knows a fixed set, so we parse their
   * arguments directly as expressions.
   */
  private parseMacro(): A.Expr {
    const nameTok = this.advance();
    const name = String(nameTok.value);
    this.expect("!");
    const open = String(this.advance().value);
    const close = open === "(" ? ")" : open === "[" ? "]" : "}";
    const start = nameTok.span;
    const args: A.Expr[] = [];
    let format: A.FormatSpec | undefined;
    let repeat = false;

    const parseFormat = () => {
      const strTok = this.tok;
      if (strTok.kind !== "string") this.fail(`format argument must be a string literal`);
      this.advance();
      const fmtArgs: A.Expr[] = [];
      while (this.eat(",")) {
        if (this.is(close)) break;
        if (this.tok.kind === "ident" && this.is("=", this.peek())) this.fail("named format arguments (`name = value`) are not supported; use `{name}` with a local variable instead");
        fmtArgs.push(this.parseExpr());
      }
      const parsed = parseFormatString(String(strTok.value), fmtArgs.length);
      if (parsed.error) this.fail(parsed.error, strTok.span);
      for (const capture of parsed.captures) {
        const p: A.Path = { id: this.id(), span: strTok.span, segments: [{ name: capture, span: strTok.span }] };
        fmtArgs.push({ kind: "path", id: this.id(), span: strTok.span, path: p });
      }
      if (parsed.positionalCount > fmtArgs.length - parsed.captures.length) {
        this.fail(`${parsed.positionalCount} positional argument(s) in format string, but ${fmtArgs.length - parsed.captures.length} given`, strTok.span);
      }
      const used = new Set(parsed.pieces.flatMap((p) => (p.kind === "hole" ? [p.arg] : [])));
      for (let i = 0; i < fmtArgs.length; i++) {
        if (!used.has(i)) this.fail("argument never used in format string", fmtArgs[i].span);
      }
      format = { pieces: parsed.pieces, args: fmtArgs, span: this.spanFrom(strTok.span) };
    };

    if (FORMAT_MACROS.has(name)) {
      if (!this.is(close)) parseFormat();
    } else if (name === "vec") {
      if (!this.is(close)) {
        args.push(this.parseExpr());
        if (this.eat(";")) {
          repeat = true;
          args.push(this.parseExpr());
        } else {
          while (this.eat(",")) {
            if (this.is(close)) break;
            args.push(this.parseExpr());
          }
        }
      }
    } else if (name === "write" || name === "writeln") {
      // `write!(f, "..", args)`: the first argument is the destination formatter.
      args.push(this.parseExpr());
      if (this.eat(",") && !this.is(close)) parseFormat();
    } else if (name === "assert" || name === "assert_eq" || name === "assert_ne" || name === "debug_assert") {
      const leading = name === "assert" || name === "debug_assert" ? 1 : 2;
      for (let i = 0; i < leading; i++) {
        if (i > 0) this.expect(",");
        args.push(this.parseExpr());
      }
      if (this.eat(",") && !this.is(close)) parseFormat();
    } else {
      this.fail(`cannot find macro \`${name}\` (TSRust supports println!, print!, eprintln!, eprint!, format!, write!, writeln!, panic!, vec!, assert!, assert_eq!, assert_ne!, unreachable!, todo!, unimplemented!)`, nameTok.span);
    }
    this.expect(close);
    return { kind: "macro", id: this.id(), span: this.spanFrom(start), name: name === "debug_assert" ? "assert" : name, args, format, repeat };
  }
}

function isBlockLike(e: A.Expr): boolean {
  return ["block", "if", "match", "loop", "while", "for"].includes(e.kind);
}

/** Attach a label to the synthesized unlabeled `break` inside a desugared `while let`. */
function relabelBreaks(body: A.BlockExpr, label: string) {
  const first = body.stmts[0];
  if (first?.kind === "expr" && first.expr.kind === "match" && first.expr.source === "while let") {
    const arm = first.expr.arms[1];
    if (arm.body.kind === "break" && !arm.body.label) arm.body.label = label;
  }
}

function describe(t: Token): string {
  if (t.kind === "eof") return "end of file";
  if (t.kind === "keyword") return `keyword \`${t.text}\``;
  if (t.kind === "ident") return `identifier \`${t.text}\``;
  if (t.kind === "punct") return `\`${t.text}\``;
  return `literal \`${t.text}\``;
}
