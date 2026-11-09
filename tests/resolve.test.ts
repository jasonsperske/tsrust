import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsOf, main, runOk } from "./helpers.ts";

test("unresolved names, types and imports", () => {
  assert.deepEqual(errorsOf(main("let x = y;")).codes, ["E0425"]);
  assert.deepEqual(errorsOf(main("let x: Strng = 1;")).codes, ["E0412"]);
  assert.deepEqual(errorsOf("use std::nothing::Here;\nfn main() {}").codes, ["E0433"]);
  assert.deepEqual(errorsOf("mod m {}\nuse m::Missing;\nfn main() {}").codes, ["E0432"]);
});

test("privacy: private items are visible in their module and its children only", () => {
  const src = `mod a { fn hidden() {} pub mod b { pub fn f() { super::hidden(); } } }
fn main() { a::b::f(); a::hidden(); }`;
  assert.deepEqual(errorsOf(src).codes, ["E0603"]);
});

test("duplicate definitions", () => {
  assert.deepEqual(errorsOf("fn f() {}\nfn f() {}\nfn main() {}").codes, ["E0428"]);
});

test("imports can depend on each other in any order (fixed point)", () => {
  const src = `mod a { pub use crate::b::Thing; }
mod b { pub use crate::c::Thing; }
mod c { pub struct Thing; impl Thing { pub fn hi(&self) -> i32 { 7 } } }
use a::Thing;
fn main() { println!("{}", Thing.hi()); }`;
  assert.equal(runOk(src), "7\n");
});

test("glob imports and enum variant imports", () => {
  const src = `mod shapes { pub enum Kind { Round, Square } pub fn n() -> i32 { 3 } }
use shapes::*;
use shapes::Kind::{Round, Square};
fn main() { let k = Round; match k { Round => println!("round {}", n()), Square => {} } }`;
  assert.equal(runOk(src), "round 3\n");
});

test("shadowing and block scoping", () => {
  assert.equal(runOk(main(`let x = 1; let x = x + 1; { let x = 10; println!("{}", x); } println!("{}", x);`)), "10\n2\n");
});

test("labels: undeclared label and break outside loop", () => {
  assert.deepEqual(errorsOf(main("loop { break 'nope; }")).codes, ["E0426"]);
  assert.deepEqual(errorsOf(main("break;")).codes, ["E0268"]);
});

test("nested fn items can't capture locals (E0434)", () => {
  assert.deepEqual(errorsOf(main("let x = 1; fn inner() -> i32 { x } println!(\"{}\", inner());")).codes, ["E0434"]);
});

test("missing main is E0601", () => {
  assert.deepEqual(errorsOf("fn not_main() {}").codes, ["E0601"]);
});
