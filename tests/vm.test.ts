import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSource, execute } from "../src/driver.ts";
import { readProgram, writeProgram } from "../src/bytecode/writer.ts";
import { main, runOk } from "./helpers.ts";

const runFull = (src: string) => {
  const c = compileSource(src);
  assert.ok(c.bytes);
  return execute(c);
};

test("bytecode survives a write/read round trip", () => {
  const c = compileSource(main(`println!("{} {}", -1.5, "π");`));
  const p = readProgram(c.bytes!);
  assert.deepEqual(p, c.program);
  assert.deepEqual(writeProgram(p), c.bytes);
});

test("bad magic numbers are rejected", () => {
  assert.throws(() => readProgram(new Uint8Array([1, 2, 3, 4, 1])), /bad magic/);
});

test("integer overflow, division by zero and bad indexes panic", () => {
  assert.match(runFull(main("let x: u8 = 255; let y = x + 1; println!(\"{}\", y);")).panic!, /attempt to add with overflow/);
  assert.match(runFull(main("let d = 0; println!(\"{}\", 1 / d);")).panic!, /divide by zero/);
  assert.match(runFull(main("let v = vec![1]; let i = 3; println!(\"{}\", v[i]);")).panic!, /index out of bounds: the len is 1 but the index is 3/);
  assert.match(runFull(main("let o: Option<i32> = None; o.unwrap();")).panic!, /called `Option::unwrap\(\)` on a `None` value/);
});

test("panics report the source location and exit code 101", () => {
  const r = runFull(main(`panic!("boom {}", 42);`));
  assert.equal(r.exitCode, 101);
  assert.match(r.stderr, /thread 'main' panicked at main\.rs:3:\d+:\nboom 42/);
});

test("process::exit sets the exit code", () => {
  assert.equal(runFull(main("println!(\"bye\"); std::process::exit(3);")).exitCode, 3);
});

test("formatting matches Rust: floats, debug strings, pretty printing", () => {
  assert.equal(runOk(main(`println!("{} {:?} {} {:?} {:.3}", 1.0, 1.0, 0.1 + 0.2, "a\\"b", 3.14159);`)), `1 1.0 0.30000000000000004 "a\\"b" 3.142\n`);
  assert.equal(runOk("#[derive(Debug)]\nstruct P { x: i32, t: (bool, char) }\n" + main(`println!("{:#?}", P { x: 1, t: (true, 'c') });`)),
    "P {\n    x: 1,\n    t: (\n        true,\n        'c',\n    ),\n}\n");
  assert.equal(runOk(main(`let v: Vec<Option<&str>> = vec![Some("a"), None]; println!("{:?} {:?}", v, ());`)), `[Some("a"), None] ()\n`);
});

test("casts truncate, wrap and saturate like Rust", () => {
  assert.equal(runOk(main(`println!("{} {} {} {} {}", 300i32 as u8, -1i32 as u32, 3.99f64 as i32, 1e10 as i32, 'A' as u8);`)), "44 4294967295 3 2147483647 65\n");
});

test("Copy aggregates are copied, not aliased", () => {
  const src = "#[derive(Clone, Copy, Debug)]\nstruct P { x: i32 }\n" + main(`let a = P { x: 1 }; let mut b = a; b.x = 2; println!("{:?} {:?}", a, b);`);
  assert.equal(runOk(src), "P { x: 1 } P { x: 2 }\n");
});

test("mem::swap and mem::replace work through references", () => {
  assert.equal(runOk(main(`let mut a = 1; let mut b = 2; std::mem::swap(&mut a, &mut b); let old = std::mem::replace(&mut a, 9); println!("{} {} {}", a, b, old);`)), "9 1 2\n");
});

test("infinite loops are stopped by the step limit", () => {
  const c = compileSource(main("loop {}"));
  const r = execute(c, { maxSteps: 10_000 });
  assert.match(r.panic!, /execution stopped/);
});
