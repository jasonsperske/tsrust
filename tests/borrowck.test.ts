import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsOf, main, runOk } from "./helpers.ts";

const err = (src: string) => errorsOf(src).codes;

test("use after move (E0382), including moves in loops and partial moves", () => {
  assert.deepEqual(err(main(`let s = String::new(); let t = s; println!("{}", s);`)), ["E0382"]);
  assert.deepEqual(err(main(`let s = String::new(); for _ in 0..2 { drop(s); }`)), ["E0382"]);
  assert.deepEqual(err("struct P { a: String, b: String }\n" + main(`let p = P { a: String::new(), b: String::new() }; let a = p.a; let q = p;`)), ["E0382"]);
  // Moving one field leaves the other usable.
  assert.deepEqual(err("struct P { a: String, b: String }\n" + main(`let p = P { a: String::new(), b: String::new() }; let a = p.a; let b = p.b;`)), []);
  // Conditional moves are tracked through control flow.
  assert.deepEqual(err(main(`let s = String::new(); let c = true; if c { drop(s); } println!("{}", s);`)), ["E0382"]);
});

test("reassigning a moved variable makes it usable again", () => {
  assert.equal(runOk(main(`let mut s = String::from("a"); let t = s; s = String::from("b"); println!("{} {}", s, t);`)), "b a\n");
});

test("aliasing XOR mutability: E0499, E0502, E0506", () => {
  assert.deepEqual(err(main(`let mut v = vec![1]; let a = &mut v; let b = &mut v; a.push(1); b.push(2);`)), ["E0499"]);
  assert.deepEqual(err(main(`let mut v = vec![1]; let r = &v; v.push(2); println!("{:?}", r);`)), ["E0502"]);
  assert.deepEqual(err(main(`let mut x = 1; let r = &x; x = 2; println!("{}", r);`)), ["E0506"]);
});

test("non-lexical lifetimes: a borrow ends at its last use", () => {
  assert.deepEqual(err(main(`let mut v = vec![1]; let r = &v; println!("{:?}", r); v.push(2);`)), []);
});

test("two-phase borrows: v.push(v.len())", () => {
  assert.equal(runOk(main(`let mut v = vec![10]; v.push(v.len()); println!("{:?}", v);`)), "[10, 1]\n");
});

test("disjoint field borrows are allowed", () => {
  assert.deepEqual(err(main(`let mut t = (1, 2); let a = &mut t.0; let b = &mut t.1; *a += 1; *b += 1;`)), []);
});

test("implicit reborrows keep &mut variables usable", () => {
  assert.deepEqual(err("fn f(v: &mut Vec<i32>) { v.push(1); v.push(2); g(v); g(v); }\nfn g(v: &mut Vec<i32>) {}\nfn main() {}"), []);
});

test("dangling references: E0597, E0515, E0106", () => {
  assert.deepEqual(err(main(`let r; { let x = 1; r = &x; } println!("{}", r);`)), ["E0597"]);
  assert.deepEqual(err("fn f() -> &'static String { let s = String::new(); &s }\nfn main() {}"), ["E0515"]);
  assert.deepEqual(err("fn f(a: &str, b: &str) -> &str { a }\nfn main() {}"), ["E0106"]);
  assert.deepEqual(err("fn f(a: &str) -> &str { a }\nfn main() {}"), []);
});

test("lifetimes in signatures decide what a call's result borrows", () => {
  // `len` returns usize: the borrow of `v` ends immediately.
  assert.deepEqual(err(main(`let mut v = vec![1]; let n = v.len(); v.push(n as i32);`)), []);
  // `first` returns Option<&T>: the result keeps `v` borrowed.
  assert.deepEqual(err(main(`let mut v = vec![1]; let f = v.first(); v.push(2); println!("{:?}", f);`)), ["E0502"]);
  // `longest<'a>` ties the result to both arguments.
  const longest = "fn longest<'a>(x: &'a str, y: &'a str) -> &'a str { if x.len() > y.len() { x } else { y } }\n";
  assert.deepEqual(err(longest + main(`let a = String::from("a"); let r; { let b = String::from("bb"); r = longest(&a, &b); } println!("{}", r);`)), ["E0597"]);
});

test("mutability: E0596, E0594, E0384", () => {
  assert.deepEqual(err(main(`let v: Vec<i32> = Vec::new(); v.push(1);`)), ["E0596"]);
  assert.deepEqual(err("struct P { x: i32 }\n" + main(`let p = P { x: 1 }; p.x = 2;`)), ["E0594"]);
  assert.deepEqual(err(main(`let x = 1; x = 2;`)), ["E0384"]);
  assert.deepEqual(err("fn f(r: &Vec<i32>) { r.push(1); }\nfn main() {}"), ["E0596"]);
  // Deferred initialization of an immutable binding is fine.
  assert.deepEqual(err(main(`let x; if true { x = 1; } else { x = 2; } println!("{}", x);`)), []);
});

test("use of uninitialized binding (E0381)", () => {
  assert.deepEqual(err(main(`let x: i32; println!("{}", x);`)), ["E0381"]);
});

test("moving out of borrowed content (E0507)", () => {
  assert.deepEqual(err(main(`let v = vec![String::new()]; let s = v[0];`)), ["E0507"]);
  assert.deepEqual(err("fn f(s: &String) -> String { *s }\nfn main() {}"), ["E0507"]);
  // Copy types can be read out of references freely.
  assert.deepEqual(err("fn f(x: &i32) -> i32 { *x }\nfn main() {}"), []);
});

test("move out while borrowed (E0505)", () => {
  assert.deepEqual(err(main(`let s = String::new(); let r = &s; let t = s; println!("{}", r);`)), ["E0505"]);
});

test("loans through a reassigned reference are killed (linked-list walk)", () => {
  const src = `struct Node { v: i32, next: Option<Box<Node>> }
fn push_back(head: &mut Option<Box<Node>>, v: i32) {
    let mut slot = head;
    while let Some(node) = slot { slot = &mut node.next; }
    *slot = Some(Box::new(Node { v, next: None }));
}
fn main() {
    let mut list = None;
    for i in 1..4 { push_back(&mut list, i); }
    let mut cur = &list;
    while let Some(n) = cur { print!("{} ", n.v); cur = &n.next; }
    println!();
}`;
  assert.equal(runOk(src), "1 2 3 \n");
});

test("regressions: early exits end scopes; loops can't re-assign immutables", () => {
  assert.deepEqual(err(main(`let r; loop { let x = 1; r = &x; break; } println!("{}", r);`)), ["E0597"]);
  assert.deepEqual(err(main(`let x; for i in 0..2 { x = i; }`)), ["E0384"]);
});

test("MIR is kept even when borrow checking fails", () => {
  const { c } = errorsOf(main(`let s = String::new(); let t = s; println!("{}", s);`));
  assert.ok(c.borrowck && c.borrowck.bodies.size > 0);
});
