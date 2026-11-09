/**
 * # Stage 10: Native code generation
 *
 * This backend translates TSRust bytecode into x86-64 machine code and links
 * it with the native runtime into an executable image.
 *
 * ```mermaid
 * flowchart LR
 *   BC["bytecode Program<br/>(.tsrb)"] --> T["translate each instruction<br/>to x86-64 (this file)"]
 *   T --> L["link: code + runtime blob<br/>+ program data"]
 *   RT["native runtime<br/>(precompiled C)"] --> L
 *   L --> F{"--target"}
 *   F -->|linux| ELF["ELF"]
 *   F -->|macos| MACHO["Mach-O"]
 *   F -->|windows| PE["PE / .exe"]
 * ```
 *
 * ## The translation is a "template compiler"
 *
 * Each stack-machine instruction becomes a fixed snippet of machine code, and
 * the VM's operand stack becomes the machine stack: `PUSH`/`POP` are real
 * `push`/`pop` instructions. A function's local slots live in its stack frame
 * at `[rbp - 8 - 8*slot]`. So
 *
 * ```text
 * LOAD 0        push qword [rbp-8]
 * LOAD 1        push qword [rbp-16]
 * ADD i32       pop rcx; pop rax; add rax, rcx
 *               movsxd rdx, eax; cmp rdx, rax; jne overflow_panic
 *               push rax
 * ```
 *
 * This is how early JIT compilers worked. It's simple and every instruction
 * is easy to read in the output; an optimizing compiler would keep values in
 * registers instead of bouncing them through memory.
 *
 * ## Values
 *
 * Every value is one 64-bit word (see native/runtime/runtime.h). That's why
 * generic code like `Vec<T>` needs no type-specific machine code: a `T` is
 * always eight bytes, whether it's an `i32`, a `&str` or a pointer to a struct.
 *
 * ## Image layout
 *
 * ```text
 * 0x0000  headers (ELF / Mach-O / PE)
 * 0x1000  our machine code: entry stub, OS shim, one function per instance   ┐ read +
 *  R      runtime machine code and constants                                ┘ execute
 *  R+d    runtime globals (heap pointer, stdout buffer)                     ┐ read +
 *  P      program data: type descriptors, string constants, (PE) imports    ┘ write
 * ```
 *
 * Everything is position-independent: code reaches data with `rip`-relative
 * addressing, so the image runs wherever the operating system loads it.
 */
import { NUM_KINDS, OPS, Op } from "../bytecode/opcodes.ts";
import { isStdFunction, type FunctionCode, type Program, type TypeDesc } from "../bytecode/program.ts";
import { RUNTIME } from "./runtime.generated.ts";
import { Assembler, CC, R, type Label } from "./x64.ts";

export type Target = "linux" | "macos" | "windows";
export const TARGETS: Target[] = ["linux", "macos", "windows"];

/** A linked image, before the target's container headers are written into its first page. */
export interface Image {
  bytes: Uint8Array;
  /** Offset of the entry point. */
  entry: number;
  /** End of the read+execute part (start of the read+write part); page aligned. */
  rxEnd: number;
  /** Where our code starts (always 0x1000) and ends. */
  codeStart: number;
  codeEnd: number;
  /** Windows only: the import directory and import address table, as image offsets. */
  imports?: { dir: number; dirSize: number; iat: number; iatSize: number };
  /** Size of each part, for reporting. */
  stats: { code: number; runtime: number; data: number; functions: number };
  /** Image offset of each function's machine code (indexed like Program.functions). */
  functionOffsets: number[];
}

export const PAGE = 0x1000;
const align = (n: number, a: number) => Math.ceil(n / a) * a;

/** Panic kinds understood by rt_panic_kind in native/runtime/runtime.c. */
const PANIC = { add: 0, sub: 1, mul: 2, div: 3, rem: 4, neg: 5, shl: 6, shr: 7, divZero: 8, remZero: 9, unreachable: 10 } as const;

/** Type descriptor kind codes; must match native/runtime/runtime.h. */
const T = { int: 0, float: 1, bool: 2, char: 3, str: 4, string: 5, unit: 6, never: 7, tuple: 8, ref: 9, box: 10, vec: 11, map: 12, struct: 13, enum: 14, opaque: 15 };
const FIELDS_KIND = { named: 0, tuple: 1, unit: 2 };

// ---------------------------------------------------------------------------
// Program data: everything our code and the runtime read at run time
// ---------------------------------------------------------------------------

class DataBuilder {
  private readonly bytes: number[] = [];
  readonly strings: { len: number; bytesAt: number }[] = [];
  private readonly stringIndex = new Map<string, number>();
  private readonly names = new Map<string, number>();
  private nameBlob: number[] = [];

  get size() {
    return this.bytes.length;
  }

  u32(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  }

  pad(to: number) {
    while (this.bytes.length % to) this.bytes.push(0);
  }

  raw(b: Iterable<number>) {
    for (const x of b) this.bytes.push(x);
  }

  setU32(at: number, v: number) {
    this.bytes[at] = v & 0xff;
    this.bytes[at + 1] = (v >> 8) & 0xff;
    this.bytes[at + 2] = (v >> 16) & 0xff;
    this.bytes[at + 3] = (v >>> 24) & 0xff;
  }

  /** Register a string constant; returns its index in the Str table. */
  str(s: string): number {
    let i = this.stringIndex.get(s);
    if (i === undefined) {
      i = this.strings.length;
      this.strings.push({ len: 0, bytesAt: -1 });
      this.stringIndex.set(s, i);
    }
    return i;
  }

  stringList(): string[] {
    return [...this.stringIndex.keys()];
  }

  name(s: string): number {
    let off = this.names.get(s);
    if (off === undefined) {
      off = this.nameBlob.length;
      const b = new TextEncoder().encode(s);
      this.nameBlob.push(b.length & 0xff, (b.length >> 8) & 0xff, 0, 0, ...b);
      while (this.nameBlob.length % 4) this.nameBlob.push(0);
      this.names.set(s, off);
    }
    return off;
  }

  takeNameBlob(): number[] {
    return this.nameBlob;
  }

  result(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Encode runtime type descriptors as u32 words (format documented in runtime.h). */
function encodeTypes(types: TypeDesc[], data: DataBuilder): { offsets: number[]; words: number[] } {
  const offsets: number[] = [];
  const words: number[] = [];
  const kindIndex = (name: string) => (NUM_KINDS as readonly string[]).indexOf(name);
  const fields = (fs: { name: string; ty: number }[]) => fs.flatMap((f) => [data.name(f.name), f.ty]);
  for (const t of types) {
    offsets.push(words.length);
    switch (t.k) {
      case "int": words.push(T.int, kindIndex(t.name)); break;
      case "float": words.push(T.float, t.name === "f32" ? 32 : 64); break;
      case "bool": words.push(T.bool); break;
      case "char": words.push(T.char); break;
      case "str": words.push(T.str); break;
      case "string": words.push(T.string); break;
      case "unit": words.push(T.unit); break;
      case "never": words.push(T.never); break;
      case "tuple": words.push(T.tuple, t.elems.length, ...t.elems); break;
      case "ref": words.push(T.ref, t.inner); break;
      case "box": words.push(T.box, t.inner); break;
      case "vec": words.push(T.vec, t.elem); break;
      case "map": words.push(T.map, t.key, t.value); break;
      case "struct": words.push(T.struct, data.name(t.name), FIELDS_KIND[t.kind], t.fields.length, ...fields(t.fields)); break;
      case "enum":
        words.push(T.enum, data.name(t.name), t.variants.length);
        for (const v of t.variants) words.push(data.name(v.name), FIELDS_KIND[v.kind], v.fields.length, ...fields(v.fields));
        break;
      case "opaque": words.push(T.opaque, data.name(t.name)); break;
    }
  }
  return { offsets, words };
}

// ---------------------------------------------------------------------------
// The translator
// ---------------------------------------------------------------------------

const kindName = (k: number) => NUM_KINDS[k];
const isFloat = (k: number) => kindName(k) === "f32" || kindName(k) === "f64";
const isSigned = (k: number) => k <= 5;
const bitsOf = (k: number): number => ({ i8: 8, u8: 8, i16: 16, u16: 16, i32: 32, u32: 32, char: 32, bool: 1 } as Record<string, number>)[kindName(k)] ?? 64;

/** Names the generated code links against: runtime functions/globals and program data. */
const rt = (sym: string) => {
  if (!(sym in RUNTIME.symbols)) throw new NativeError(`the native runtime has no \`${sym}\``);
  return { abs: `rt:${sym}` };
};
const pd = (name: string) => ({ abs: `pd:${name}` });

export class NativeError extends Error {}

export function intrinsicSymbol(name: string): string {
  return `rt_i_${name.replace(/::/g, "__")}`;
}

class Translator {
  readonly asm = new Assembler();
  readonly fnLabels: Label[];
  private readonly p: Program;
  private readonly data: DataBuilder;

  constructor(p: Program, data: DataBuilder) {
    this.p = p;
    this.data = data;
    this.fnLabels = p.functions.map(() => this.asm.label());
  }

  /**
   * Call a runtime function. Arguments that live on the operand stack are
   * passed as a pointer to the stack top (rdi = rsp); `regs` are extra
   * immediate arguments. The stack is 16-byte aligned for the call, as the
   * System V ABI requires, then `pop` stack values are dropped and the result
   * (rax) is pushed if `push` is set.
   */
  private rtCall(sym: string, opts: { sp?: boolean; regs?: number[]; pop?: number; push?: boolean }) {
    const a = this.asm;
    const argRegs = opts.sp ? [R.rsi, R.rdx, R.rcx, R.r8] : [R.rdi, R.rsi, R.rdx, R.rcx];
    if (opts.sp) a.movRR(R.rdi, R.rsp);
    (opts.regs ?? []).forEach((v, i) => a.movImm(argRegs[i], v));
    a.movRR(R.rbx, R.rsp);
    a.andImm(R.rsp, -16);
    a.call(rt(sym));
    a.movRR(R.rsp, R.rbx);
    if (opts.pop) a.addImm(R.rsp, 8 * opts.pop);
    if (opts.push) a.push(R.rax);
  }

  /** Jump to a per-function panic stub if the condition holds. */
  private panicIf(cc: number, kind: number, stubs: Map<number, Label>) {
    let l = stubs.get(kind);
    if (!l) { l = this.asm.label(); stubs.set(kind, l); }
    this.asm.jcc(cc, l);
  }

  /** After 64-bit arithmetic on a narrower type, check the result still fits (else panic). */
  private checkRange(k: number, kind: number, stubs: Map<number, Label>) {
    const a = this.asm;
    const bits = bitsOf(k);
    if (bits >= 64) return;
    if (isSigned(k)) {
      if (bits === 8) a.movsx8(R.rdx, R.rax);
      else if (bits === 16) a.movsx16(R.rdx, R.rax);
      else a.movsxd(R.rdx, R.rax);
      a.cmp(R.rdx, R.rax);
      this.panicIf(CC.ne, kind, stubs);
    } else {
      a.movRR(R.rdx, R.rax);
      a.shrImm(R.rdx, bits);
      this.panicIf(CC.ne, kind, stubs);
    }
  }

  /** Truncate rax to the type's width, sign- or zero-extending (wrapping semantics). */
  private wrap(k: number) {
    const a = this.asm;
    const bits = bitsOf(k);
    if (bits >= 64) return;
    if (isSigned(k)) {
      if (bits === 8) a.movsx8(R.rax, R.rax);
      else if (bits === 16) a.movsx16(R.rax, R.rax);
      else a.movsxd(R.rax, R.rax);
    } else if (bits === 8) a.movzx8(R.rax, R.rax);
    else if (bits === 16) a.movzx16(R.rax, R.rax);
    else a.mov32(R.rax, R.rax);
  }

  private local(slot: number): number {
    return -8 - 8 * slot;
  }

  private strConst(s: string) {
    return pd(`str:${this.data.str(s)}`);
  }

  compileFunction(index: number, f: FunctionCode) {
    const a = this.asm;
    a.bind(this.fnLabels[index]);
    // Prologue: frame pointer, room for locals (touching each page, as Windows
    // requires for large frames), then copy the arguments into their slots.
    a.push(R.rbp);
    a.movRR(R.rbp, R.rsp);
    let frame = align(8 * Math.max(f.locals, 1), 16);
    while (frame > PAGE) {
      a.subImm(R.rsp, PAGE);
      a.storeImm(R.rsp, 0, 0);
      frame -= PAGE;
    }
    a.subImm(R.rsp, frame);
    for (let i = 0; i < f.params; i++) {
      a.load(R.rax, R.rbp, 16 + 8 * (f.params - 1 - i));
      a.store(R.rbp, this.local(i), R.rax);
    }

    // Find instruction boundaries, and give each a label for jumps.
    const starts: number[] = [];
    for (let ip = 0; ip < f.code.length; ip += 1 + OPS[f.code[ip]].operands.length) starts.push(ip);
    const labels = new Map(starts.map((ip) => [ip, a.label()]));
    const locAt = new Map<number, number>();
    for (let i = 0; i < f.lines.length; i += 2) locAt.set(f.lines[i], f.lines[i + 1]);
    const stubs = new Map<number, Label>();
    let currentLoc = -1;
    // Like #[track_caller]: code in the standard library doesn't update the
    // panic location, so a failing `unwrap()` reports where *you* called it.
    const trackCaller = isStdFunction(this.p, f);
    const setLoc = (loc: number) => {
      if (trackCaller) return;
      const l = this.p.locs[loc];
      if (!l) return;
      a.leaRip(R.rax, this.strConst(`${l.file}:${l.line}:${l.col}`));
      a.storeRip(rt("rt_loc"), R.rax);
    };

    for (const ip of starts) {
      a.bind(labels.get(ip)!);
      const loc = locAt.get(ip);
      if (loc !== undefined && loc !== currentLoc) { currentLoc = loc; setLoc(loc); }
      const op = f.code[ip];
      const x = f.code[ip + 1], y = f.code[ip + 2], z = f.code[ip + 3];
      this.instruction(op, x, y, z, labels, f, stubs, () => { if (currentLoc >= 0) setLoc(currentLoc); });
    }
    a.ud2();

    // Out-of-line panic stubs for this function's overflow and zero checks.
    for (const [kind, l] of stubs) {
      a.bind(l);
      a.movImm(R.rdi, kind);
      a.andImm(R.rsp, -16);
      a.call(rt("rt_panic_kind"));
    }
  }

  private instruction(op: number, x: number, y: number, z: number, labels: Map<number, Label>, f: FunctionCode, stubs: Map<number, Label>, restoreLoc: () => void) {
    const a = this.asm;
    const target = (ip: number) => {
      const l = labels.get(ip);
      if (!l) throw new NativeError(`${f.name}: jump into the middle of an instruction`);
      return l;
    };
    switch (op) {
      case Op.NOP: return;
      case Op.CONST: {
        const c = this.p.constants[x];
        if (typeof c === "string") { a.leaRip(R.rax, this.strConst(c)); a.push(R.rax); }
        else if (Number.isInteger(c) && c >= -0x80000000 && c < 0x80000000) a.pushImm(c);
        else { a.movImm(R.rax, BigInt.asIntN(64, BigInt(Math.trunc(c)))); a.push(R.rax); }
        return;
      }
      case Op.CONST_F: {
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, this.p.constants[x] as number, true);
        a.movImm(R.rax, view.getBigUint64(0, true));
        a.push(R.rax);
        return;
      }
      case Op.CONST_CHAR: a.pushImm((this.p.constants[x] as string).codePointAt(0)!); return;
      case Op.UNIT: case Op.FALSE: a.pushImm(0); return;
      case Op.TRUE: a.pushImm(1); return;
      case Op.POP: a.addImm(R.rsp, 8); return;
      case Op.DUP: a.pushMem(R.rsp, 0); return;

      case Op.LOAD: a.pushMem(R.rbp, this.local(x)); return;
      case Op.STORE: a.popMem(R.rbp, this.local(x)); return;
      case Op.REF_LOCAL: a.lea(R.rax, R.rbp, this.local(x)); a.push(R.rax); return;
      // A reference is an address: dereferencing loads from it.
      case Op.LOAD_REF: case Op.DEREF_REF: case Op.STR_REF: a.pop(R.rax); a.pushMem(R.rax, 0); return;
      case Op.STR_OF: return; // a String is laid out as a valid &str
      case Op.STORE_REF: a.pop(R.rcx); a.pop(R.rax); a.store(R.rax, 0, R.rcx); return;
      case Op.FIELD_REF: a.pop(R.rax); a.load(R.rax, R.rax, 0); a.addImm(R.rax, 8 + 8 * x); a.push(R.rax); return;
      case Op.INDEX_REF: case Op.INDEX_GET: {
        a.pop(R.rcx); // index
        a.pop(R.rax);
        if (op === Op.INDEX_REF) a.load(R.rax, R.rax, 0); // &Vec → Vec
        const ok = a.label();
        a.cmpMem(R.rcx, R.rax, 0); // index < len?
        a.jcc(CC.b, ok);
        a.load(R.rdi, R.rax, 0);
        a.movRR(R.rsi, R.rcx);
        a.andImm(R.rsp, -16);
        a.call(rt("rt_index_fail"));
        a.bind(ok);
        a.load(R.rax, R.rax, 8); // data pointer
        a.shlImm(R.rcx, 3);
        a.add(R.rax, R.rcx);
        if (op === Op.INDEX_REF) a.push(R.rax);
        else a.pushMem(R.rax, 0);
        return;
      }

      case Op.MAKE_AGG: this.rtCall("rt_make_agg", { sp: true, regs: [x, y], pop: y, push: true }); return;
      case Op.GET_FIELD: a.pop(R.rax); a.pushMem(R.rax, 8 + 8 * x); return;
      case Op.GET_TAG: a.pop(R.rax); a.load32(R.rax, R.rax, 0); a.push(R.rax); return;
      case Op.GET_BOX: a.pop(R.rax); a.pushMem(R.rax, 0); return;
      case Op.COPY: this.rtCall("rt_copy", { sp: true, regs: [x], pop: 1, push: true }); return;

      case Op.ADD: case Op.SUB: case Op.MUL: case Op.DIV: case Op.REM: return this.arith(op, x, stubs);
      case Op.NEG: {
        a.pop(R.rax);
        if (isFloat(x)) a.btc(R.rax, 63);
        else {
          a.neg(R.rax);
          if (bitsOf(x) >= 64) this.panicIf(CC.o, PANIC.neg, stubs);
          else this.checkRange(x, PANIC.neg, stubs);
        }
        a.push(R.rax);
        return;
      }
      case Op.NOT: {
        a.pop(R.rax);
        if (kindName(x) === "bool") a.xorImm(R.rax, 1);
        else { a.not(R.rax); this.wrap(x); }
        a.push(R.rax);
        return;
      }
      case Op.BITAND: case Op.BITOR: case Op.BITXOR:
        a.pop(R.rcx);
        a.pop(R.rax);
        if (op === Op.BITAND) a.and(R.rax, R.rcx);
        else if (op === Op.BITOR) a.or(R.rax, R.rcx);
        else a.xor(R.rax, R.rcx);
        a.push(R.rax);
        return;
      case Op.SHL: case Op.SHR: {
        a.pop(R.rcx);
        a.pop(R.rax);
        a.cmpImm(R.rcx, Math.max(bitsOf(x), 8));
        this.panicIf(CC.ae, op === Op.SHL ? PANIC.shl : PANIC.shr, stubs);
        if (op === Op.SHL) { a.shlCl(R.rax); this.wrap(x); }
        else if (isSigned(x)) a.sarCl(R.rax);
        else a.shrCl(R.rax);
        a.push(R.rax);
        return;
      }
      case Op.CAST: return this.cast(x, y);

      case Op.EQ: case Op.NE: case Op.LT: case Op.LE: case Op.GT: case Op.GE: return this.compare(op, x);
      case Op.DEEP_EQ: this.rtCall("rt_deep_eq", { sp: true, regs: [x], pop: 2, push: true }); return;
      case Op.DEEP_CMP: this.rtCall("rt_deep_cmp", { sp: true, regs: [x], pop: 2, push: true }); return;
      case Op.CLONE: this.rtCall("rt_clone", { sp: true, regs: [x], pop: 1, push: true }); return;
      case Op.DEFAULT: this.rtCall("rt_default", { regs: [x], push: true }); return;

      case Op.JUMP: a.jmp(target(x)); return;
      case Op.JUMP_IF_FALSE: case Op.JUMP_IF_TRUE:
        a.pop(R.rax);
        a.test(R.rax, R.rax);
        a.jcc(op === Op.JUMP_IF_FALSE ? CC.e : CC.ne, target(x));
        return;
      case Op.CALL:
        a.call(this.fnLabels[x]);
        a.addImm(R.rsp, 8 * y);
        a.push(R.rax);
        restoreLoc(); // the callee moved the "current location" for panics
        return;
      case Op.RET: a.pop(R.rax); a.movRR(R.rsp, R.rbp); a.pop(R.rbp); a.ret(); return;
      case Op.INTRINSIC: {
        const name = this.p.intrinsics[x];
        this.rtCall(intrinsicSymbol(name), { sp: true, regs: [y], pop: y, push: true });
        return;
      }
      case Op.PANIC: this.rtCall("rt_panic", { sp: true }); return;
      case Op.UNREACHABLE: a.movImm(R.rdi, PANIC.unreachable); a.andImm(R.rsp, -16); a.call(rt("rt_panic_kind")); return;

      case Op.NEW_STRING: this.rtCall("rt_new_string", { push: true }); return;
      case Op.STR_APPEND: this.rtCall("rt_str_append", { sp: true, pop: 2 }); return;
      case Op.FMT: this.rtCall("rt_fmt", { sp: true, regs: [x, y, z], pop: 2 }); return;
      case Op.PRINT: this.rtCall("rt_print", { sp: true, regs: [x], pop: 1 }); return;
    }
    throw new NativeError(`no native translation for ${OPS[op]?.name ?? op}`);
  }

  private arith(op: number, k: number, stubs: Map<number, Label>) {
    const a = this.asm;
    a.pop(R.rcx); // b
    a.pop(R.rax); // a
    if (isFloat(k)) {
      if (op === Op.REM) {
        a.movRR(R.rdi, R.rax);
        a.movRR(R.rsi, R.rcx);
        a.movRR(R.rbx, R.rsp);
        a.andImm(R.rsp, -16);
        a.call(rt("rt_frem"));
        a.movRR(R.rsp, R.rbx);
      } else {
        a.movqToX(0, R.rax);
        a.movqToX(1, R.rcx);
        if (op === Op.ADD) a.addsd(0, 1);
        else if (op === Op.SUB) a.subsd(0, 1);
        else if (op === Op.MUL) a.mulsd(0, 1);
        else a.divsd(0, 1);
        if (kindName(k) === "f32") a.roundToF32(0);
        a.movqFromX(R.rax, 0);
      }
      a.push(R.rax);
      return;
    }
    const wide = bitsOf(k) >= 64;
    const signed = isSigned(k);
    switch (op) {
      case Op.ADD:
        a.add(R.rax, R.rcx);
        if (wide) this.panicIf(signed ? CC.o : CC.b, PANIC.add, stubs);
        else this.checkRange(k, PANIC.add, stubs);
        break;
      case Op.SUB:
        a.sub(R.rax, R.rcx);
        if (wide) this.panicIf(signed ? CC.o : CC.b, PANIC.sub, stubs);
        else this.checkRange(k, PANIC.sub, stubs);
        break;
      case Op.MUL:
        if (wide && !signed) { a.mul(R.rcx); this.panicIf(CC.o, PANIC.mul, stubs); }
        else {
          a.imul(R.rax, R.rcx);
          if (wide) this.panicIf(CC.o, PANIC.mul, stubs);
          else this.checkRange(k, PANIC.mul, stubs);
        }
        break;
      case Op.DIV: case Op.REM: {
        const isRem = op === Op.REM;
        a.test(R.rcx, R.rcx);
        this.panicIf(CC.e, isRem ? PANIC.remZero : PANIC.divZero, stubs);
        if (signed) {
          // MIN / -1 overflows (and `idiv` would trap), so handle -1 separately.
          const normal = a.label(), done = a.label();
          a.cmpImm(R.rcx, -1);
          a.jcc(CC.ne, normal);
          a.movImm(R.rdx, bitsOf(k) >= 64 ? -(2n ** 63n) : -(2n ** BigInt(bitsOf(k) - 1)));
          a.cmp(R.rax, R.rdx);
          this.panicIf(CC.e, isRem ? PANIC.rem : PANIC.div, stubs);
          if (isRem) a.movImm(R.rax, 0);
          else a.neg(R.rax);
          a.jmp(done);
          a.bind(normal);
          a.cqo();
          a.idiv(R.rcx);
          if (isRem) a.movRR(R.rax, R.rdx);
          a.bind(done);
        } else {
          a.movImm(R.rdx, 0);
          a.div(R.rcx);
          if (isRem) a.movRR(R.rax, R.rdx);
        }
        break;
      }
    }
    a.push(R.rax);
  }

  private compare(op: number, k: number) {
    const a = this.asm;
    const cc = (s: number, u: number) => (isSigned(k) || kindName(k) === "str" ? s : u);
    const table: Record<number, number> = {
      [Op.EQ]: CC.e, [Op.NE]: CC.ne,
      [Op.LT]: cc(CC.l, CC.b), [Op.LE]: cc(CC.le, CC.be), [Op.GT]: cc(CC.g, CC.a), [Op.GE]: cc(CC.ge, CC.ae),
    };
    if (kindName(k) === "str") {
      this.rtCall("rt_str_cmp", { sp: true, pop: 2 });
      a.movImm(R.rcx, 0);
      a.cmp(R.rax, R.rcx);
    } else if (isFloat(k)) {
      a.pop(R.rcx);
      a.pop(R.rax);
      a.movqToX(0, R.rax);
      a.movqToX(1, R.rcx);
      // Unordered comparisons (NaN) must be false, except `!=`.
      if (op === Op.LT || op === Op.LE) a.ucomisd(1, 0);
      else a.ucomisd(0, 1);
      if (op === Op.EQ || op === Op.NE) {
        a.setcc(op === Op.EQ ? CC.e : CC.ne, R.rax);
        a.setcc(op === Op.EQ ? CC.np : CC.p, R.rcx);
        if (op === Op.EQ) a.and(R.rax, R.rcx);
        else a.or(R.rax, R.rcx);
        a.movzx8(R.rax, R.rax);
      } else {
        a.setcc(op === Op.LT || op === Op.GT ? CC.a : CC.ae, R.rax);
        a.movzx8(R.rax, R.rax);
      }
      a.push(R.rax);
      return;
    } else {
      a.pop(R.rcx);
      a.pop(R.rax);
      a.cmp(R.rax, R.rcx);
    }
    a.setcc(table[op], R.rax);
    a.movzx8(R.rax, R.rax);
    a.push(R.rax);
  }

  /** `as` conversions go through the runtime: rt_cast(value, from, to). */
  cast(from: number, to: number) {
    const a = this.asm;
    a.pop(R.rdi);
    a.movImm(R.rsi, from);
    a.movImm(R.rdx, to);
    a.movRR(R.rbx, R.rsp);
    a.andImm(R.rsp, -16);
    a.call(rt("rt_cast"));
    a.movRR(R.rsp, R.rbx);
    a.push(R.rax);
  }
}

// ---------------------------------------------------------------------------
// OS shims: the three host functions the runtime needs, per target
// ---------------------------------------------------------------------------

/** Windows functions imported from kernel32.dll, in import-table order. */
export const WIN_IMPORTS = ["GetStdHandle", "WriteFile", "ExitProcess", "VirtualAlloc"];

function emitShims(a: Assembler, target: Target, labels: { write: Label; exit: Label; alloc: Label }) {
  const { write, exit, alloc } = labels;
  if (target === "linux" || target === "macos") {
    // System calls take their arguments in rdi, rsi, rdx, r10, r8, r9: almost the
    // C calling convention, so write(fd, buf, len) passes straight through.
    const sys = target === "linux" ? { write: 1, exit: 231, mmap: 9, anon: 0x22 } : { write: 0x2000004, exit: 0x2000001, mmap: 0x20000c5, anon: 0x1002 };
    a.bind(write);
    a.movImm(R.rax, sys.write);
    a.syscall();
    a.ret();
    a.bind(exit);
    a.movImm(R.rax, sys.exit);
    a.syscall();
    a.ud2();
    a.bind(alloc); // mmap(NULL, size, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0)
    a.movRR(R.rsi, R.rdi);
    a.movImm(R.rdi, 0);
    a.movImm(R.rdx, 3);
    a.movImm(R.r10, sys.anon);
    a.movImm(R.r8, -1);
    a.movImm(R.r9, 0);
    a.movImm(R.rax, sys.mmap);
    a.syscall();
    a.ret();
    return;
  }
  // Windows: no stable system calls, so call kernel32.dll through the import
  // table, translating from the System V convention (rdi, rsi, rdx) that the
  // runtime uses to the Microsoft x64 convention (rcx, rdx, r8, r9, plus 32
  // bytes of "shadow space" and a 16-byte aligned stack).
  const iat = (name: string) => pd(`iat:${name}`);
  a.bind(write); // write(fd, buf, len) → WriteFile(GetStdHandle(fd == 2 ? -12 : -11), buf, len, &written, NULL)
  a.push(R.rbp);
  a.movRR(R.rbp, R.rsp);
  a.subImm(R.rsp, 64);
  a.andImm(R.rsp, -16);
  a.store(R.rbp, -8, R.rdx);
  a.store(R.rbp, -16, R.rsi);
  const notErr = a.label();
  a.movImm(R.rcx, -11);
  a.cmpImm(R.rdi, 2);
  a.jcc(CC.ne, notErr);
  a.movImm(R.rcx, -12);
  a.bind(notErr);
  a.callRipMem(iat("GetStdHandle"));
  a.movRR(R.rcx, R.rax);
  a.load(R.rdx, R.rbp, -16);
  a.load(R.r8, R.rbp, -8);
  a.lea(R.r9, R.rbp, -24);
  a.storeImm(R.rsp, 32, 0);
  a.callRipMem(iat("WriteFile"));
  a.movRR(R.rsp, R.rbp);
  a.pop(R.rbp);
  a.ret();
  a.bind(exit); // ExitProcess(code)
  a.andImm(R.rsp, -16);
  a.subImm(R.rsp, 32);
  a.movRR(R.rcx, R.rdi);
  a.callRipMem(iat("ExitProcess"));
  a.ud2();
  a.bind(alloc); // VirtualAlloc(NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
  a.push(R.rbp);
  a.movRR(R.rbp, R.rsp);
  a.andImm(R.rsp, -16);
  a.subImm(R.rsp, 32);
  a.movImm(R.rcx, 0);
  a.movRR(R.rdx, R.rdi);
  a.movImm(R.r8, 0x3000);
  a.movImm(R.r9, 4);
  a.callRipMem(iat("VirtualAlloc"));
  a.movRR(R.rsp, R.rbp);
  a.pop(R.rbp);
  a.ret();
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

let runtimeBytes: Uint8Array | undefined;
function runtimeBlob(): Uint8Array {
  if (!runtimeBytes) {
    const bin = atob(RUNTIME.base64);
    runtimeBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) runtimeBytes[i] = bin.charCodeAt(i);
  }
  return runtimeBytes;
}

/** Translate a program and link it into a flat image (headers left blank). */
export function buildImage(p: Program, target: Target): Image {
  for (const name of p.intrinsics) {
    if (!(intrinsicSymbol(name) in RUNTIME.symbols)) throw new NativeError(`intrinsic \`${name}\` is not available in the native runtime`);
  }
  const data = new DataBuilder();
  const tr = new Translator(p, data);
  const a = tr.asm;

  // Entry point: align the stack, initialize the runtime, run main, exit(0).
  const entry = a.label();
  const shims = { write: a.label(), exit: a.label(), alloc: a.label() };
  a.bind(entry);
  a.andImm(R.rsp, -16);
  a.leaRip(R.rdi, shims.write);
  a.leaRip(R.rsi, shims.exit);
  a.leaRip(R.rdx, shims.alloc);
  a.leaRip(R.rcx, pd("meta"));
  a.call(rt("rt_init"));
  a.call(tr.fnLabels[p.entry]);
  a.movImm(R.rdi, 0);
  a.call(rt("rt_exit"));
  emitShims(a, target, shims);

  p.functions.forEach((f, i) => tr.compileFunction(i, f));

  // ---- Program data ------------------------------------------------------
  const { offsets, words } = encodeTypes(p.types, data);
  // Pre-register loc strings and constants used by the code (already done during translation).
  const metaAt = 0;
  data.raw(new Array(24).fill(0)); // Meta header, filled in below
  const typeOffsetsAt = data.size;
  for (const o of offsets) data.u32(o);
  const typeDataAt = data.size;
  for (const w of words) data.u32(w);
  const namesAt = data.size;
  data.raw(data.takeNameBlob());
  data.pad(8);
  const strings = data.stringList();
  const stringsAt = data.size;
  data.raw(new Array(16 * strings.length).fill(0));
  const stringBytesAt: number[] = [];
  for (const s of strings) {
    stringBytesAt.push(data.size);
    data.raw(new TextEncoder().encode(s));
  }
  data.pad(8);
  let iatSlots: Record<string, number> = {};

  // ---- Layout -------------------------------------------------------------
  const codeStart = PAGE;
  const codeEnd = codeStart + a.pos;
  const rtStart = align(codeEnd, PAGE);
  const rtBlob = runtimeBlob();
  const rxEnd = rtStart + RUNTIME.dataOffset;
  const pdStart = align(rtStart + rtBlob.length, PAGE);

  // Windows import tables live at the end of program data (they need image addresses).
  let imports: Image["imports"];
  let pdBytes: Uint8Array;
  if (target === "windows") {
    const rva = (off: number) => pdStart + off;
    const dirAt = data.size;
    data.raw(new Array(40).fill(0)); // one descriptor + null terminator
    const iltAt = data.size;
    data.raw(new Array(8 * (WIN_IMPORTS.length + 1)).fill(0));
    const iatAt = data.size;
    data.raw(new Array(8 * (WIN_IMPORTS.length + 1)).fill(0));
    const hintAt: number[] = [];
    for (const name of WIN_IMPORTS) {
      data.pad(2);
      hintAt.push(data.size);
      data.raw([0, 0, ...new TextEncoder().encode(name), 0]);
    }
    const dllAt = data.size;
    data.raw([...new TextEncoder().encode("KERNEL32.dll"), 0]);
    data.pad(8);
    const bytes = data.result();
    const patch = (at: number, v: number) => { bytes[at] = v & 0xff; bytes[at + 1] = (v >> 8) & 0xff; bytes[at + 2] = (v >> 16) & 0xff; bytes[at + 3] = (v >>> 24) & 0xff; };
    WIN_IMPORTS.forEach((_, i) => { patch(iltAt + 8 * i, rva(hintAt[i])); patch(iatAt + 8 * i, rva(hintAt[i])); });
    patch(dirAt + 0, rva(iltAt)); // OriginalFirstThunk
    patch(dirAt + 12, rva(dllAt)); // Name
    patch(dirAt + 16, rva(iatAt)); // FirstThunk
    imports = { dir: rva(dirAt), dirSize: 40, iat: rva(iatAt), iatSize: 8 * (WIN_IMPORTS.length + 1) };
    iatSlots = Object.fromEntries(WIN_IMPORTS.map((n, i) => [n, iatAt + 8 * i]));
    pdBytes = bytes;
  } else {
    pdBytes = data.result();
  }
  // Meta header (offsets relative to the meta block itself).
  const meta = [p.types.length, typeOffsetsAt, typeDataAt, namesAt, stringsAt, strings.length];
  meta.forEach((v, i) => {
    pdBytes[metaAt + 4 * i] = v & 0xff;
    pdBytes[metaAt + 4 * i + 1] = (v >> 8) & 0xff;
    pdBytes[metaAt + 4 * i + 2] = (v >> 16) & 0xff;
    pdBytes[metaAt + 4 * i + 3] = (v >>> 24) & 0xff;
  });
  // String table: { len, offset of bytes relative to this entry } — fixed up by rt_init.
  const dv = new DataView(pdBytes.buffer);
  strings.forEach((s, i) => {
    const at = stringsAt + 16 * i;
    dv.setBigUint64(at, BigInt(new TextEncoder().encode(s).length), true);
    dv.setBigInt64(at + 8, BigInt(stringBytesAt[i] - at), true);
  });

  const end = pdStart + pdBytes.length;
  a.link(codeStart, (name) => {
    const [kind, rest] = [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)];
    if (kind === "rt") return rtStart + RUNTIME.symbols[rest];
    if (rest === "meta") return pdStart + metaAt;
    if (rest.startsWith("str:")) return pdStart + stringsAt + 16 * Number(rest.slice(4));
    if (rest.startsWith("iat:")) return pdStart + iatSlots[rest.slice(4)];
    throw new NativeError(`unresolved symbol ${name}`);
  });

  const bytes = new Uint8Array(end);
  bytes.set(a.bytes, codeStart);
  bytes.set(rtBlob, rtStart);
  bytes.set(pdBytes, pdStart);
  return {
    bytes, entry: codeStart + a.labelOffset(entry), rxEnd, codeStart, codeEnd, imports,
    stats: { code: a.pos, runtime: rtBlob.length, data: pdBytes.length, functions: p.functions.length },
    functionOffsets: tr.fnLabels.map((l) => codeStart + a.labelOffset(l)),
  };
}
