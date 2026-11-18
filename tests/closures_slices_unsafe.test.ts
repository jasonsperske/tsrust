import { test } from "node:test";
import assert from "node:assert/strict";
import { errorsOf, main, runOk } from "./helpers.ts";

const codes = (src: string) => errorsOf(src).codes;

test("closures infer captures: by reference, by mutable reference, by value", () => {
  assert.equal(runOk(main(`let k = 2; let f = |x: i32| x * k; println!("{} {}", f(3), k);`)), "6 2\n");
  assert.equal(runOk(main(`let mut n = 0; let mut f = || n += 1; f(); f(); println!("{}", n);`)), "2\n");
  assert.equal(runOk(main(`let s = String::from("a"); let f = move || s.len(); println!("{} {}", f(), f());`)), "1 1\n");
});

test("captures are precise: disjoint fields stay usable", () => {
  const src = `struct P { a: i32, b: i32 }\n` + main(`let mut p = P { a: 1, b: 2 }; let mut f = || p.a += 1; let r = &p.b; f(); println!("{} {}", r, p.a);`);
  assert.equal(runOk(src), "2 2\n");
});

test("closure signatures come from the bound they are passed to", () => {
  assert.equal(runOk(main(`println!("{:?}", vec![1, 2].iter().map(|x| x + 1).filter(|x| x % 2 == 0).collect::<Vec<i32>>());`)), "[2]\n");
  assert.deepEqual(codes(`fn a<F: Fn(i32)>(_f: F) {}\n` + main("a(|| ());")), ["E0593"]);
  assert.deepEqual(codes(`fn a<F: Fn(i32)>(_f: F) {}\n` + main(`a(|_x: &str| ());`)), ["E0631"]);
});

test("closure kinds are enforced", () => {
  assert.deepEqual(codes(`fn a<F: Fn()>(_f: F) {}\n` + main("let mut n = 0; a(|| n += 1);")), ["E0594"]);
  assert.deepEqual(codes(`fn a<F: Fn()>(_f: F) {}\n` + main("let s = String::new(); let f = || drop(s); a(f);")), ["E0525"]);
  assert.deepEqual(codes(main("let s = String::new(); let f = || s; f(); f();")), ["E0382"]);
  assert.deepEqual(codes(main("let mut x = 0; let f = || x += 1; f();")), ["E0596"]);
});

test("closures hold their borrows", () => {
  assert.deepEqual(codes(main("let mut x = 0; let mut f = || x += 1; x = 5; f();")), ["E0506"]);
  assert.deepEqual(codes(main("let mut x = 0; let mut a = || x += 1; let mut b = || x += 1; a(); b();")), ["E0499"]);
  assert.deepEqual(codes(main("let mut v = vec![1]; let it = v.iter().map(|x| x + 1); v.push(1); it.count();")), ["E0502"]);
  assert.deepEqual(codes("fn f() -> impl Fn() -> i32 { let x = 1; || x }\nfn main() {}"), ["E0373"]);
});

test("function items, constructors and fn pointers are values", () => {
  const src = `fn dbl(x: i32) -> i32 { x * 2 }\nfn run(f: fn(i32) -> i32) -> i32 { f(1) }\n`;
  assert.equal(runOk(src + main(`println!("{} {}", run(dbl), run(|x| x + 1)); println!("{:?}", [1].map(Some));`)), "2 2\n[Some(1)]\n");
  assert.deepEqual(codes(src + main("let k = 1; run(|x| x + k);")), ["E0308"]);
});

test("arrays copy, slices view", () => {
  assert.equal(runOk(main(`let mut a = [1, 2]; let b = a; a[0] = 9; println!("{:?} {:?}", a, b);`)), "[9, 2] [1, 2]\n");
  assert.equal(runOk(main(`let mut a = [1, 2, 3]; a[1..].reverse(); let s = &a[..2]; println!("{:?} {}", s, s.len());`)), "[1, 3] 2\n");
  assert.equal(runOk(main(`let v = vec![1, 2]; println!("{} {}", v == [1, 2], &v[..1] == [1]);`)), "true true\n");
});

test("slice patterns and their exhaustiveness", () => {
  const f = `fn f(s: &[i32]) -> i32 { match s { [] => 0, [x] => *x, [a, .., b] => a + b } }\n`;
  assert.equal(runOk(f + main(`println!("{} {} {}", f(&[]), f(&[5]), f(&[1, 2, 3]));`)), "0 5 4\n");
  assert.deepEqual(codes("fn f(s: &[i32]) -> i32 { match s { [] => 0, [_] => 1 } }\nfn main() {}"), ["E0004"]);
  assert.deepEqual(codes("fn f(s: &[i32]) { let [_a] = s; }\nfn main() {}"), ["E0005"]);
  assert.deepEqual(codes(main("let [_a, _b] = [1, 2, 3];")), ["E0527"]);
  assert.deepEqual(codes(main("let [_a, _b, ..] = [1];")), ["E0528"]);
});

test("slices and arrays are borrow checked", () => {
  assert.deepEqual(codes(main("let mut v = vec![1]; let s = &v[..]; v.push(2); println!(\"{:?}\", s);")), ["E0502"]);
  assert.deepEqual(codes(main("let s; { let a = [1]; s = &a[..]; } println!(\"{:?}\", s);")), ["E0597"]);
  assert.deepEqual(codes(main("let a = [String::new()]; let _b = a[0];")), ["E0508"]);
  assert.equal(runOk(main(`let mut a = [1, 2]; let [x, y] = &mut a; std::mem::swap(x, y); println!("{:?}", a);`)), "[2, 1]\n");
});

test("borrows through String and Vec deref keep their owner borrowed", () => {
  assert.deepEqual(codes(main(`let r; { let s = String::from("a"); r = s.trim(); } println!("{}", r);`)), ["E0597"]);
});

test("const generics", () => {
  const src = `fn len<T, const N: usize>(_a: &[T; N]) -> usize { N }\nfn mk<const M: usize>() -> [u8; M] { [1; M] }\n`;
  assert.equal(runOk(src + main(`println!("{} {:?}", len(&[1, 2, 3]), mk::<2>());`)), "3 [1, 1]\n");
});

test("unsafe operations need an unsafe context", () => {
  assert.deepEqual(codes(main("let x = 1; let p = &x as *const i32; let _y = *p;")), ["E0133"]);
  assert.deepEqual(codes("unsafe fn f() {}\n" + main("f();")), ["E0133"]);
  assert.deepEqual(codes("static mut X: i32 = 0;\n" + main("X = 1;")), ["E0133"]);
  assert.deepEqual(codes("unsafe trait T {}\nimpl T for i32 {}\nfn main() {}"), ["E0200"]);
  assert.deepEqual(codes("trait T {}\nunsafe impl T for i32 {}\nfn main() {}"), ["E0199"]);
  assert.deepEqual(codes(main("let mut x = 1; let p = &mut x as *const i32; unsafe { *p = 2; }")), ["E0594"]);
});

test("raw pointers, statics and UnsafeCell", () => {
  assert.equal(runOk(main(`let mut x = 1; let p = &mut x as *mut i32; unsafe { *p += 1; } println!("{}", x);`)), "2\n");
  assert.equal(runOk("static mut N: i32 = 1;\n" + main(`unsafe { N += 1; println!("{}", N); }`)), "2\n");
  assert.equal(runOk(main(`let a = [1, 2]; let p = a.as_ptr(); println!("{}", unsafe { *p.add(1) });`)), "2\n");
  assert.equal(runOk(`use std::cell::UnsafeCell;\n` + main(`let c = UnsafeCell::new(1); unsafe { *c.get() = 2; } println!("{}", c.into_inner());`)), "2\n");
});
