import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileSource, renderDiagnostics } from "../src/driver.ts";
import { MemoryFileSystem } from "../src/crates/fs.ts";
import { buildExecutable, hostTarget } from "../src/native/index.ts";
import { intrinsicSymbol } from "../src/native/compile.ts";
import { RUNTIME } from "../src/native/runtime.generated.ts";
import { Assembler, R } from "../src/native/x64.ts";
import { buildIntrinsics } from "../src/vm/intrinsics.ts";
import { readProgram, writeProgram } from "../src/bytecode/writer.ts";

const examples = join(import.meta.dirname, "..", "examples");
const canRun = hostTarget(process.platform, process.arch) === "linux";
const work = mkdtempSync(join(tmpdir(), "tsrust-native-"));

function program(src: string) {
  const c = compileSource(src);
  assert.ok(c.program, renderDiagnostics(c));
  return c.program!;
}

function runNative(src: string): { stdout: string; stderr: string; status: number | null } {
  const exe = join(work, `t${Math.random().toString(36).slice(2)}`);
  writeFileSync(exe, buildExecutable(program(src), "linux").bytes);
  chmodSync(exe, 0o755);
  const r = spawnSync(exe, { encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

test("assembler encodings match the x86-64 manual", () => {
  const a = new Assembler();
  a.load(R.rax, R.rbp, -16); // mov rax, [rbp-16]
  a.push(R.r12);
  a.movsx8(R.rdx, R.rax); // movsx rdx, al
  a.movqToX(0, R.rax); // movq xmm0, rax
  a.store(R.rsp, 8, R.rcx); // mov [rsp+8], rcx  (needs a SIB byte)
  a.addImm(R.rsp, 16);
  const hex = a.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  assert.equal(hex, "48 8b 85 f0 ff ff ff 41 54 48 0f be d0 66 48 0f 6e c0 48 89 8c 24 08 00 00 00 48 83 c4 10");
});

test("every VM intrinsic has a native implementation", () => {
  const missing = [...buildIntrinsics().keys()].filter((n) => !(intrinsicSymbol(n) in RUNTIME.symbols));
  assert.deepEqual(missing, []);
});

test("executable formats: ELF, Mach-O and PE headers", () => {
  const p = program(`fn main() { println!("hi"); }`);
  const elf = buildExecutable(p, "linux").bytes;
  assert.deepEqual([...elf.slice(0, 4)], [0x7f, 0x45, 0x4c, 0x46]);
  assert.equal(new DataView(elf.buffer).getUint16(16, true), 3); // ET_DYN

  const macho = buildExecutable(p, "macos").bytes;
  const mv = new DataView(macho.buffer);
  assert.equal(mv.getUint32(0, true), 0xfeedfacf);
  assert.equal(mv.getUint32(4, true), 0x01000007); // x86-64
  // Find LC_MAIN and check its entry point lands on the code page.
  let off = 32, entry = -1;
  for (let i = 0; i < mv.getUint32(16, true); i++) {
    const cmd = mv.getUint32(off, true);
    if (cmd === 0x80000028) entry = Number(mv.getBigUint64(off + 8, true));
    off += mv.getUint32(off + 4, true);
  }
  assert.equal(entry, 0x1000);

  const exe = buildExecutable(p, "windows");
  assert.equal(exe.extension, ".exe");
  const pe = exe.bytes;
  assert.equal(String.fromCharCode(pe[0], pe[1]), "MZ");
  const peOff = new DataView(pe.buffer).getUint32(0x3c, true);
  assert.equal(String.fromCharCode(...pe.slice(peOff, peOff + 2)), "PE");
  assert.equal(new DataView(pe.buffer).getUint16(peOff + 4, true), 0x8664);
  const text = new TextDecoder().decode(pe);
  for (const name of ["KERNEL32.dll", "WriteFile", "ExitProcess", "VirtualAlloc", "GetStdHandle"]) assert.ok(text.includes(name), name);
});

test("a .tsrb file compiles to the same executable as the source", () => {
  const c = compileSource(`fn main() { let v = vec![1, 2, 3]; println!("{:?}", v); }`);
  const fromSource = buildExecutable(c.program!, "linux").bytes;
  const fromBytecode = buildExecutable(readProgram(writeProgram(c.program!)), "linux").bytes;
  assert.deepEqual(fromBytecode, fromSource);
});

test("native executables match rustc's output for every example", { skip: !canRun && "needs Linux x86-64" }, () => {
  for (const name of readdirSync(examples).filter((f) => f.endsWith(".rs"))) {
    const r = runNative(readFileSync(join(examples, name), "utf8"));
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout, readFileSync(join(examples, name.replace(/\.rs$/, ".expected")), "utf8"), name);
  }
});

test("native panics: message, location and exit code 101", { skip: !canRun && "needs Linux x86-64" }, () => {
  const cases: [string, RegExp][] = [
    [`fn main() { let v = vec![1]; let i = 5; println!("{}", v[i]); }`, /index out of bounds: the len is 1 but the index is 5/],
    [`fn main() { let x: u8 = 255; let y = x + 1; println!("{}", y); }`, /attempt to add with overflow/],
    [`fn main() { let d = 0; println!("{}", 10 / d); }`, /attempt to divide by zero/],
    [`fn main() { let o: Option<i32> = None; o.unwrap(); }`, /called `Option::unwrap\(\)` on a `None` value/],
    [`fn main() { let m = i32::MIN; let n = -1; println!("{}", m % n); }`, /remainder with overflow/],
  ];
  for (const [src, msg] of cases) {
    const r = runNative(src);
    assert.equal(r.status, 101, src);
    assert.match(r.stderr, /thread 'main' panicked at main\.rs:1:\d+:/);
    assert.match(r.stderr, msg);
  }
});

test("native code has real 64-bit integers and exact float formatting", { skip: !canRun && "needs Linux x86-64" }, () => {
  const r = runNative(`fn main() {
    let big: u64 = 3000000000 * 3000000000;
    println!("{} {} {:?} {:?} {:.0} {:.0} {:?}", big, 0.1 + 0.2, 1e21, 1e-7, 2.5, 3.5, 1.5f32 * 3.0);
    std::process::exit(3);
  }`);
  // Real 64-bit arithmetic (the VM would panic past 2^53), and float output identical to rustc.
  assert.equal(r.stdout, "9000000000000000000 0.30000000000000004 1e21 1e-7 2 4 4.5\n");
  assert.equal(r.status, 3);
});

test("multi-crate packages build natively", { skip: !canRun && "needs Linux x86-64" }, () => {
  const root = join(examples, "packages");
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files[p.slice(root.length)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  const c = compile({ fs: new MemoryFileSystem(files), entry: "/app" });
  const exe = join(work, "app");
  writeFileSync(exe, buildExecutable(c.program!, "linux").bytes);
  chmodSync(exe, 0o755);
  assert.equal(spawnSync(exe, { encoding: "utf8" }).stdout, "=== shapes ===\ntotal area: 7.142\n***\n");
});
