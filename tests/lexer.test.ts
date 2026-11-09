import { test } from "node:test";
import assert from "node:assert/strict";
import { Diagnostics } from "../src/diagnostics.ts";
import { lex } from "../src/lexer/lexer.ts";

const kinds = (src: string) => lex(src, 0, new Diagnostics()).map((t) => `${t.kind}:${t.text}`);

test("keywords, identifiers and punctuation", () => {
  assert.deepEqual(kinds("fn main() -> i32 { x += 1; }"), [
    "keyword:fn", "ident:main", "punct:(", "punct:)", "punct:->", "ident:i32", "punct:{",
    "ident:x", "punct:+=", "int:1", "punct:;", "punct:}", "eof:",
  ]);
});

test("number literals with suffixes, underscores, radixes and floats", () => {
  const toks = lex("1_000 0xff 0b101 7u8 2.5 1e3 3.0f32 1..10", 0, new Diagnostics());
  assert.deepEqual(toks.slice(0, -1).map((t) => [t.kind, t.value, t.suffix ?? ""]), [
    ["int", 1000, ""], ["int", 255, ""], ["int", 5, ""], ["int", 7, "u8"], ["float", 2.5, ""],
    ["float", 1000, ""], ["float", 3, "f32"], ["int", 1, ""], ["punct", "..", ""], ["int", 10, ""],
  ]);
});

test("strings, chars, escapes and lifetimes", () => {
  const toks = lex(`"a\\n\\"b" 'c' '\\n' 'a fn<'b>`, 0, new Diagnostics());
  assert.equal(toks[0].value, 'a\n"b');
  assert.equal(toks[1].kind, "char");
  assert.equal(toks[2].value, "\n");
  assert.equal(toks[3].kind, "lifetime");
  assert.equal(toks[3].value, "a");
  assert.equal(toks[6].kind, "lifetime");
});

test("nested block comments are skipped", () => {
  assert.deepEqual(kinds("a /* x /* y */ z */ b // c\nd"), ["ident:a", "ident:b", "ident:d", "eof:"]);
});

test("`>` tokens are marked joint so `>>` can be reassembled", () => {
  const toks = lex("a >> b > c", 0, new Diagnostics());
  assert.equal(toks[1].joint, true);
  assert.equal(toks[2].joint, false);
});

test("unknown characters produce a diagnostic but lexing continues", () => {
  const d = new Diagnostics();
  const toks = lex("let ¤ x", 0, d);
  assert.equal(d.list.length, 1);
  assert.equal(toks.filter((t) => t.kind === "ident").length, 1);
});
