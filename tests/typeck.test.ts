import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsOf, main, runOk } from "./helpers.ts";

test("inference: literals default to i32/f64, Vec element types flow from use", () => {
  assert.equal(runOk(main(`let mut v = Vec::new(); v.push(1u8); let x = 2.5; let n = 3; println!("{:?} {} {}", v, x * 2.0, n / 2);`)), "[1] 5 1\n");
});

test("mismatched types (E0308)", () => {
  assert.deepEqual(errorsOf(main(`let x: i32 = "s";`)).codes, ["E0308"]);
  assert.deepEqual(errorsOf("fn f() -> i32 { true }\nfn main() {}").codes, ["E0308"]);
  assert.deepEqual(errorsOf(main(`let x = if true { 1 } else { "no" };`)).codes, ["E0308"]);
});

test("no implicit numeric conversions", () => {
  assert.deepEqual(errorsOf(main("let a: u8 = 1; let b: i32 = 2; let c = a + b;")).codes, ["E0277"]);
});

test("method lookup: autoref, autoderef, deref to str", () => {
  const src = main(`let s = String::from("héllo"); let r = &&s; println!("{} {} {}", s.len(), r.len(), r.to_uppercase());`);
  assert.equal(runOk(src), "6 6 HÉLLO\n");
});

test("unknown method and field", () => {
  assert.deepEqual(errorsOf(main("let v = vec![1]; v.nope();")).codes, ["E0599"]);
  assert.deepEqual(errorsOf("struct P { x: i32 }\n" + main("let p = P { x: 1 }; let y = p.y;")).codes, ["E0609"]);
});

test("struct literal checks: unknown, missing and private fields", () => {
  assert.deepEqual(errorsOf("struct P { x: i32 }\n" + main("let p = P { x: 1, z: 2 };")).codes, ["E0560"]);
  assert.deepEqual(errorsOf("struct P { x: i32, y: i32 }\n" + main("let p = P { x: 1 };")).codes, ["E0063"]);
  assert.deepEqual(errorsOf("mod m { pub struct P { x: i32 } }\n" + main("let p = m::P { x: 1 };")).codes, ["E0451"]);
});

test("trait bounds are enforced at call sites (E0277)", () => {
  const src = `struct NoDebug;
fn show<T: std::fmt::Debug>(t: T) { println!("{:?}", t); }
fn main() { show(NoDebug); }`;
  assert.deepEqual(errorsOf(src).codes, ["E0277"]);
});

test("missing trait items (E0046) and extra items (E0407)", () => {
  assert.deepEqual(errorsOf("trait T { fn a(&self); fn b(&self); }\nstruct S;\nimpl T for S { fn a(&self) {} }\nfn main() {}").codes, ["E0046"]);
  assert.deepEqual(errorsOf("trait T { fn a(&self); }\nstruct S;\nimpl T for S { fn a(&self) {} fn z(&self) {} }\nfn main() {}").codes, ["E0407"]);
});

test("incompatible impl method signature (E0053)", () => {
  assert.deepEqual(errorsOf("trait T { fn a(&self) -> i32; }\nstruct S;\nimpl T for S { fn a(&self) -> bool { true } }\nfn main() {}").codes, ["E0053"]);
});

test("exhaustiveness (E0004) with witnesses, and refutable let (E0005)", () => {
  const r = errorsOf(main("let o: Option<(bool, i32)> = None; match o { Some((true, _)) => {}, None => {} }"));
  assert.deepEqual(r.codes, ["E0004"]);
  assert.match(r.messages[0], /`Some\(\(false, _\)\)` not covered/);
  assert.deepEqual(errorsOf(main("let o = Some(1); let Some(x) = o;")).codes, ["E0005"]);
  assert.deepEqual(errorsOf(main("let n = 3; match n { 0 => {} }")).codes, ["E0004"]);
});

test("recursive types need indirection (E0072)", () => {
  assert.deepEqual(errorsOf("struct Node { next: Option<Node> }\nfn main() {}").codes, ["E0072"]);
  assert.deepEqual(errorsOf("struct Node { next: Option<Box<Node>> }\nfn main() {}").codes, []);
});

test("derive(Copy) requires Copy fields (E0204)", () => {
  assert.deepEqual(errorsOf("#[derive(Clone, Copy)]\nstruct S { name: String }\nfn main() {}").codes, ["E0204"]);
});

test("the ? operator needs a compatible return type", () => {
  assert.deepEqual(errorsOf(`fn f() -> i32 { let x: Option<i32> = None; x? }\nfn main() {}`).codes, ["E0277"]);
});

test("associated types and generic traits: Iterator, IntoIterator, FromIterator", () => {
  const src = `struct Up { n: u32 }
impl Iterator for Up { type Item = u32; fn next(&mut self) -> Option<u32> { if self.n < 3 { self.n += 1; Some(self.n) } else { None } } }
fn total<I: Iterator<Item = u32>>(it: I) -> u32 { let mut t = 0; for x in it { t += x; } t }
fn main() { let v: Vec<u32> = Up { n: 0 }.collect(); println!("{:?} {}", v, total(Up { n: 0 })); }`;
  assert.equal(runOk(src), "[1, 2, 3] 6\n");
});

test("integer literal ranges infer their element type from use", () => {
  assert.equal(runOk("fn f(x: u64) -> u64 { x * 2 }\n" + main("let mut t = 0; for i in 1..=4 { t += f(i); } println!(\"{}\", t);")), "20\n");
});

test("regressions: literal ranges, block-local struct fields, shift-assign, Box Display", () => {
  assert.match(errorsOf(main("let x: u8 = 300;")).messages[0], /literal out of range for `u8`/);
  assert.deepEqual(errorsOf(main("let y: i8 = -128;")).codes, []);
  assert.equal(runOk(main(`struct P { x: i32 } let p = P { x: 4 }; let mut y = 8u32; y >>= 2; y <<= 3; println!("{} {}", p.x, y);`)), "4 16\n");
  assert.equal(runOk("use std::fmt;\nstruct M;\nimpl fmt::Display for M { fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { write!(f, \"m\") } }\n" + main(`println!("{}", Box::new(M));`)), "m\n");
});
