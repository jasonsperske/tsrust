import { test } from "node:test";
import assert from "node:assert/strict";
import { Diagnostics } from "../src/diagnostics.ts";
import { lex } from "../src/lexer/lexer.ts";
import { NodeIdGen, type Expr } from "../src/parser/ast.ts";
import { parseExpression, parseFile } from "../src/parser/parser.ts";
import { parseFormatString } from "../src/parser/format.ts";

function expr(src: string): Expr {
  const d = new Diagnostics();
  const e = parseExpression(lex(src, 0, d), new NodeIdGen(), d);
  assert.equal(d.list.length, 0, d.list.map((x) => x.message).join("\n"));
  return e!;
}

/** Render an expression with explicit parentheses, to check grouping. */
function show(e: Expr): string {
  switch (e.kind) {
    case "binary": return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case "unary": return `(${e.op}${show(e.expr)})`;
    case "lit": return String(e.value.kind === "str" ? JSON.stringify(e.value.value) : (e.value as { value: unknown }).value);
    case "path": return e.path.segments.map((s) => s.name).join("::");
    case "cast": return `(${show(e.expr)} as _)`;
    case "methodCall": return `${show(e.receiver)}.${e.method}(${e.args.map(show).join(", ")})`;
    case "field": return `${show(e.expr)}.${e.name}`;
    case "assign": return `(${show(e.target)} ${e.op} ${show(e.value)})`;
    case "range": return `(${e.start ? show(e.start) : ""}${e.inclusive ? "..=" : ".."}${e.end ? show(e.end) : ""})`;
    default: return e.kind;
  }
}

test("operator precedence and associativity", () => {
  assert.equal(show(expr("1 + 2 * 3 - 4")), "((1 + (2 * 3)) - 4)");
  assert.equal(show(expr("a || b && c == d")), "(a || (b && (c == d)))");
  assert.equal(show(expr("-a * b")), "((-a) * b)");
  assert.equal(show(expr("x as i64 + 1")), "((x as _) + 1)");
  assert.equal(show(expr("a = b = c")), "(a = (b = c))");
  assert.equal(show(expr("1 << 2 + 3")), "(1 << (2 + 3))");
  assert.equal(show(expr("0..n + 1")), "(0..(n + 1))");
});

test("postfix chains: fields, methods, tuple indexes", () => {
  assert.equal(show(expr("a.b.c(1).d")), "a.b.c(1).d");
  assert.equal(show(expr("t.0.1")), "t.0.1");
});

test("comparison operators cannot be chained", () => {
  const d = new Diagnostics();
  parseExpression(lex("a < b < c", 0, d), new NodeIdGen(), d);
  assert.match(d.list[0].message, /cannot be chained/);
});

test("struct literals are not allowed in `if` conditions", () => {
  const d = new Diagnostics();
  const file = parseFile(lex("fn f() { if x == S { } }", 0, d), 0, new NodeIdGen(), d);
  assert.equal(d.list.length, 0);
  assert.equal(file.items.length, 1);
});

test("`if let` and `while let` are desugared into `match`", () => {
  const d = new Diagnostics();
  const file = parseFile(lex("fn f() { if let Some(x) = y { } while let Some(z) = w { } }", 0, d), 0, new NodeIdGen(), d);
  const body = (file.items[0] as { body: { stmts: { expr: Expr }[]; tail: Expr } }).body;
  assert.equal(body.stmts[0].expr.kind, "match");
  assert.equal(body.tail.kind, "loop");
});

test("items: generics, where clauses, traits with associated types", () => {
  const src = `
    pub struct Pair<T> { pub a: T, b: T }
    enum E { A, B(i32), C { x: u8 } }
    trait Tr: Clone { type Out; fn f(&self) -> Self::Out; fn g(&mut self) {} }
    impl<T> Tr for Pair<T> where T: Clone { type Out = T; fn f(&self) -> T { self.a.clone() } }
    use std::collections::{HashMap, self as c};
    mod m;`;
  const d = new Diagnostics();
  const file = parseFile(lex(src, 0, d), 0, new NodeIdGen(), d);
  assert.equal(d.list.length, 0, d.list.map((x) => x.message).join("\n"));
  assert.deepEqual(file.items.map((i) => i.kind), ["struct", "enum", "trait", "impl", "use", "mod"]);
});

test("parse errors recover at the next item", () => {
  const d = new Diagnostics();
  const file = parseFile(lex("fn a() { let = ; } fn b() {}", 0, d), 0, new NodeIdGen(), d);
  assert.ok(d.list.length >= 1);
  assert.ok(file.items.some((i) => i.kind === "fn" && i.name === "b"));
});

test("format strings: positional, named captures, debug, precision", () => {
  const f = parseFormatString("{} {0} {name:?} {:.2} {{x}}", 2);
  assert.equal(f.error, undefined);
  assert.deepEqual(f.captures, ["name"]);
  const holes = f.pieces.filter((p) => p.kind === "hole");
  assert.deepEqual(holes.map((h) => h.kind === "hole" && [h.arg, h.debug, h.precision ?? null]), [[0, false, null], [0, false, null], [2, true, null], [1, false, 2]]);
  assert.ok(f.pieces.some((p) => p.kind === "text" && p.text.includes("{x}")));
});
