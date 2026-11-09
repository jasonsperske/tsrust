/**
 * # Stage 8: Writing and reading `.tsrb` files
 *
 * A compiled {@link Program} is serialized into a compact binary format, so it
 * can be saved, downloaded from the playground, and run later without the
 * compiler.
 *
 * ```text
 * ┌──────────────────────────────────────────────┐
 * │ magic "TSRB" │ version (u8)                  │
 * ├──────────────────────────────────────────────┤
 * │ constants: count, then each:                 │
 * │   tag 0 = f64 (8 bytes LE) │ tag 1 = string  │
 * │ types:     JSON string (descriptors)         │
 * │ intrinsics: count, then strings              │
 * │ locations: count, then (file, line, col)     │
 * │ functions: count, then each:                 │
 * │   name, params, locals,                      │
 * │   code length, code (varints),               │
 * │   line table length, line table (varints)    │
 * │ entry function index                         │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * Integers use **LEB128 varints** (7 bits per byte, high bit = "more bytes
 * follow"), so small numbers — most opcodes and operands — take one byte.
 * Signed values (like the `-1` "no precision" operand) are **zigzag**-encoded
 * first so they stay small too. Strings are UTF-8 with a varint length prefix.
 */
import type { Program } from "./program.ts";

const MAGIC = [0x54, 0x53, 0x52, 0x42]; // "TSRB"
export const FORMAT_VERSION = 2;

class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;

  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf);
    this.buf = next;
  }

  byte(b: number) {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  /** Unsigned LEB128. */
  uvar(n: number) {
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      this.byte(b);
    } while (n > 0);
  }

  /** Zigzag then LEB128: 0 → 0, -1 → 1, 1 → 2, -2 → 3 ... */
  svar(n: number) {
    this.uvar(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  f64(n: number) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.len, n, true);
    this.len += 8;
  }

  str(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.uvar(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    if (this.pos >= this.bytes.length) throw new Error("unexpected end of .tsrb file");
    return this.bytes[this.pos++];
  }

  uvar(): number {
    let n = 0, mul = 1, b: number;
    do {
      b = this.byte();
      n += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return n;
  }

  svar(): number {
    const z = this.uvar();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  f64(): number {
    const v = new DataView(this.bytes.buffer, this.bytes.byteOffset).getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  str(): string {
    const n = this.uvar();
    const s = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
}

export function writeProgram(p: Program): Uint8Array {
  const w = new ByteWriter();
  for (const b of MAGIC) w.byte(b);
  w.byte(FORMAT_VERSION);
  w.uvar(p.constants.length);
  for (const c of p.constants) {
    if (typeof c === "number") { w.byte(0); w.f64(c); }
    else { w.byte(1); w.str(c); }
  }
  w.str(JSON.stringify(p.types));
  w.uvar(p.intrinsics.length);
  for (const name of p.intrinsics) w.str(name);
  w.uvar(p.locs.length);
  for (const l of p.locs) { w.str(l.file); w.uvar(l.line); w.uvar(l.col); }
  w.uvar(p.functions.length);
  for (const f of p.functions) {
    w.str(f.name);
    w.uvar(f.params);
    w.uvar(f.locals);
    w.uvar(f.code.length);
    for (const x of f.code) w.svar(x);
    w.uvar(f.lines.length);
    for (const x of f.lines) w.svar(x);
  }
  w.uvar(p.entry);
  return w.result();
}

export function readProgram(bytes: Uint8Array): Program {
  const r = new ByteReader(bytes);
  for (const b of MAGIC) if (r.byte() !== b) throw new Error("not a TSRust bytecode file (bad magic number)");
  const version = r.byte();
  if (version !== FORMAT_VERSION) throw new Error(`unsupported .tsrb version ${version} (expected ${FORMAT_VERSION})`);
  const constants: (number | string)[] = [];
  for (let n = r.uvar(); n > 0; n--) constants.push(r.byte() === 0 ? r.f64() : r.str());
  const types = JSON.parse(r.str());
  const intrinsics: string[] = [];
  for (let n = r.uvar(); n > 0; n--) intrinsics.push(r.str());
  const locs = [];
  for (let n = r.uvar(); n > 0; n--) locs.push({ file: r.str(), line: r.uvar(), col: r.uvar() });
  const functions = [];
  for (let n = r.uvar(); n > 0; n--) {
    const name = r.str();
    const params = r.uvar();
    const locals = r.uvar();
    const code: number[] = [];
    for (let c = r.uvar(); c > 0; c--) code.push(r.svar());
    const lines: number[] = [];
    for (let c = r.uvar(); c > 0; c--) lines.push(r.svar());
    functions.push({ name, params, locals, code, lines });
  }
  return { constants, types, intrinsics, locs, functions, entry: r.uvar() };
}
