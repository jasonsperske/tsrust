/**
 * # A tiny x86-64 assembler
 *
 * Just enough of the x86-64 instruction set to translate TSRust bytecode,
 * encoded by hand. Each method appends the bytes of one instruction.
 *
 * x86-64 encoding in one paragraph: an instruction is
 * `[REX prefix] opcode [ModRM] [SIB] [displacement] [immediate]`. The REX
 * byte (`0100WRXB`) sets 64-bit operand size (W) and supplies the fourth bit
 * of register numbers 8–15 (R for the ModRM.reg field, B for ModRM.rm). The
 * ModRM byte (`mod:2 reg:3 rm:3`) names a register operand and a register or
 * memory operand; `mod = 10` means "memory at [rm + disp32]", `mod = 11`
 * means "register rm". `rm = 100` (rsp/r12) needs an extra SIB byte, and
 * `mod = 00, rm = 101` means "[rip + disp32]", which is how
 * position-independent code addresses its data.
 *
 * ```text
 * mov rax, [rbp-16]   =  48 8B 85 F0 FF FF FF
 *                        │  │  │  └───────── disp32 = -16
 *                        │  │  └──────────── ModRM: mod=10 reg=rax rm=rbp
 *                        │  └─────────────── opcode MOV r64, r/m64
 *                        └────────────────── REX.W (64-bit operands)
 * ```
 *
 * Branches and RIP-relative references to labels are emitted with a 32-bit
 * placeholder and patched once every label's address is known.
 */

/** Register numbers as used in instruction encodings. */
export const R = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
} as const;
export type R = number;

/** Condition codes, for `jcc` and `setcc`. */
export const CC = { o: 0, no: 1, b: 2, ae: 3, e: 4, ne: 5, be: 6, a: 7, s: 8, ns: 9, p: 10, np: 11, l: 12, ge: 13, le: 14, g: 15 } as const;
export type CC = number;

export type Label = { id: number };

interface Fixup {
  /** Position of the 32-bit field to patch. */
  at: number;
  /** Address the instruction's rip points at: the end of the instruction. */
  next: number;
  target: Label | { abs: string };
}

export class Assembler {
  bytes: number[] = [];
  private readonly labelPos: (number | undefined)[] = [];
  private readonly fixups: Fixup[] = [];

  get pos(): number {
    return this.bytes.length;
  }

  label(): Label {
    this.labelPos.push(undefined);
    return { id: this.labelPos.length - 1 };
  }

  bind(l: Label) {
    this.labelPos[l.id] = this.pos;
  }

  labelOffset(l: Label): number {
    const p = this.labelPos[l.id];
    if (p === undefined) throw new Error("unbound label");
    return p;
  }

  private b(...xs: number[]) {
    for (const x of xs) this.bytes.push(x & 0xff);
  }

  private d32(v: number) {
    this.b(v, v >> 8, v >> 16, v >> 24);
  }

  private d64(v: bigint) {
    for (let i = 0n; i < 8n; i++) this.b(Number((v >> (8n * i)) & 0xffn));
  }

  /** REX prefix: W for 64-bit, R/B extend the reg/rm fields. Emitted only when needed (or forced). */
  private rex(w: boolean, reg: number, rm: number, force = false) {
    const v = 0x40 | (w ? 8 : 0) | (reg & 8 ? 4 : 0) | (rm & 8 ? 1 : 0);
    if (v !== 0x40 || force) this.b(v);
  }

  /** ModRM for a register-to-register operation. */
  private modrmReg(reg: number, rm: number) {
    this.b(0xc0 | ((reg & 7) << 3) | (rm & 7));
  }

  /** ModRM (+SIB) for `[base + disp32]`. */
  private modrmMem(reg: number, base: number, disp: number) {
    this.b(0x80 | ((reg & 7) << 3) | (base & 7));
    if ((base & 7) === 4) this.b(0x24); // SIB: base only
    this.d32(disp);
  }

  /** ModRM for `[rip + disp32]`, with a fixup to a label or an absolute (named) image address. */
  private modrmRip(reg: number, target: Label | { abs: string }, immBytes = 0) {
    this.b(((reg & 7) << 3) | 5);
    const at = this.pos;
    this.d32(0);
    this.fixups.push({ at, next: this.pos + immBytes, target });
  }

  // ---------------------------------------------------------------------
  // Data movement
  // ---------------------------------------------------------------------

  push(r: R) { this.rex(false, 0, r); this.b(0x50 + (r & 7)); }
  pop(r: R) { this.rex(false, 0, r); this.b(0x58 + (r & 7)); }
  /** push imm32 (sign-extended to 64 bits) */
  pushImm(v: number) { this.b(0x68); this.d32(v); }
  /** push qword [base + disp] */
  pushMem(base: R, disp: number) { this.rex(false, 0, base); this.b(0xff); this.modrmMem(6, base, disp); }
  /** pop qword [base + disp] */
  popMem(base: R, disp: number) { this.rex(false, 0, base); this.b(0x8f); this.modrmMem(0, base, disp); }
  movRR(dst: R, src: R) { this.rex(true, src, dst); this.b(0x89); this.modrmReg(src, dst); }
  /** mov dst, imm64 (uses the short forms when the value fits) */
  movImm(dst: R, v: bigint | number) {
    const n = BigInt.asIntN(64, BigInt(v));
    if (n >= 0n && n <= 0xffffffffn) { this.rex(false, 0, dst); this.b(0xb8 + (dst & 7)); this.d32(Number(n)); return; }
    if (n >= -0x80000000n && n < 0x80000000n) { this.rex(true, 0, dst); this.b(0xc7); this.modrmReg(0, dst); this.d32(Number(n)); return; }
    this.rex(true, 0, dst); this.b(0xb8 + (dst & 7)); this.d64(n);
  }
  load(dst: R, base: R, disp = 0) { this.rex(true, dst, base); this.b(0x8b); this.modrmMem(dst, base, disp); }
  store(base: R, disp: number, src: R) { this.rex(true, src, base); this.b(0x89); this.modrmMem(src, base, disp); }
  /** mov dst32, dword [base + disp] (zero-extends) */
  load32(dst: R, base: R, disp = 0) { this.rex(false, dst, base); this.b(0x8b); this.modrmMem(dst, base, disp); }
  /** mov qword [base + disp], imm32 (sign-extended) */
  storeImm(base: R, disp: number, v: number) { this.rex(true, 0, base); this.b(0xc7); this.modrmMem(0, base, disp); this.d32(v); }
  lea(dst: R, base: R, disp: number) { this.rex(true, dst, base); this.b(0x8d); this.modrmMem(dst, base, disp); }
  leaRip(dst: R, target: Label | { abs: string }) { this.rex(true, dst, 0); this.b(0x8d); this.modrmRip(dst, target); }
  /** mov qword [rip + target], src */
  storeRip(target: Label | { abs: string }, src: R) { this.rex(true, src, 0); this.b(0x89); this.modrmRip(src, target); }

  // ---------------------------------------------------------------------
  // Arithmetic
  // ---------------------------------------------------------------------

  private alu(op: number, dst: R, src: R) { this.rex(true, src, dst); this.b(op); this.modrmReg(src, dst); }
  add(dst: R, src: R) { this.alu(0x01, dst, src); }
  sub(dst: R, src: R) { this.alu(0x29, dst, src); }
  and(dst: R, src: R) { this.alu(0x21, dst, src); }
  or(dst: R, src: R) { this.alu(0x09, dst, src); }
  xor(dst: R, src: R) { this.alu(0x31, dst, src); }
  cmp(dst: R, src: R) { this.alu(0x39, dst, src); }
  test(dst: R, src: R) { this.alu(0x85, dst, src); }
  /** cmp reg, qword [base + disp] */
  cmpMem(reg: R, base: R, disp: number) { this.rex(true, reg, base); this.b(0x3b); this.modrmMem(reg, base, disp); }

  /** add/sub/and/cmp/... r64, imm32 (group 1: /0 add, /4 and, /5 sub, /7 cmp) */
  private aluImm(ext: number, dst: R, v: number) {
    this.rex(true, 0, dst);
    if (v >= -128 && v <= 127) { this.b(0x83); this.modrmReg(ext, dst); this.b(v); }
    else { this.b(0x81); this.modrmReg(ext, dst); this.d32(v); }
  }
  addImm(dst: R, v: number) { if (v) this.aluImm(0, dst, v); }
  subImm(dst: R, v: number) { if (v) this.aluImm(5, dst, v); }
  andImm(dst: R, v: number) { this.aluImm(4, dst, v); }
  xorImm(dst: R, v: number) { this.aluImm(6, dst, v); }
  cmpImm(dst: R, v: number) { this.aluImm(7, dst, v); }

  imul(dst: R, src: R) { this.rex(true, dst, src); this.b(0x0f, 0xaf); this.modrmReg(dst, src); }
  /** Group 3 on rax: /2 not, /3 neg, /4 mul, /6 div, /7 idiv */
  private grp3(ext: number, r: R) { this.rex(true, 0, r); this.b(0xf7); this.modrmReg(ext, r); }
  not(r: R) { this.grp3(2, r); }
  neg(r: R) { this.grp3(3, r); }
  mul(r: R) { this.grp3(4, r); }
  div(r: R) { this.grp3(6, r); }
  idiv(r: R) { this.grp3(7, r); }
  /** cqo: sign-extend rax into rdx:rax */
  cqo() { this.b(0x48, 0x99); }
  /** shl/shr/sar r64, cl (group 2: /4 shl, /5 shr, /7 sar) */
  shlCl(r: R) { this.rex(true, 0, r); this.b(0xd3); this.modrmReg(4, r); }
  shrCl(r: R) { this.rex(true, 0, r); this.b(0xd3); this.modrmReg(5, r); }
  sarCl(r: R) { this.rex(true, 0, r); this.b(0xd3); this.modrmReg(7, r); }
  shrImm(r: R, n: number) { this.rex(true, 0, r); this.b(0xc1); this.modrmReg(5, r); this.b(n); }
  shlImm(r: R, n: number) { this.rex(true, 0, r); this.b(0xc1); this.modrmReg(4, r); this.b(n); }
  /** btc r64, imm8: flip one bit (used to negate floats) */
  btc(r: R, bit: number) { this.rex(true, 0, r); this.b(0x0f, 0xba); this.modrmReg(7, r); this.b(bit); }
  /** movsx r64, r8 / r16;  movsxd r64, r32 */
  movsx8(dst: R, src: R) { this.rex(true, dst, src, true); this.b(0x0f, 0xbe); this.modrmReg(dst, src); }
  movsx16(dst: R, src: R) { this.rex(true, dst, src); this.b(0x0f, 0xbf); this.modrmReg(dst, src); }
  movsxd(dst: R, src: R) { this.rex(true, dst, src); this.b(0x63); this.modrmReg(dst, src); }
  /** movzx r32, r8 / r16 (implicitly zero-extends to 64) */
  movzx8(dst: R, src: R) { this.rex(false, dst, src, true); this.b(0x0f, 0xb6); this.modrmReg(dst, src); }
  movzx16(dst: R, src: R) { this.rex(false, dst, src); this.b(0x0f, 0xb7); this.modrmReg(dst, src); }
  /** mov r32, r32: zero-extends into the full 64-bit register */
  mov32(dst: R, src: R) { this.rex(false, src, dst); this.b(0x89); this.modrmReg(src, dst); }
  setcc(cc: CC, r: R) { this.rex(false, 0, r, true); this.b(0x0f, 0x90 + cc); this.modrmReg(0, r); }

  // ---------------------------------------------------------------------
  // SSE2 floating point (scalar double)
  // ---------------------------------------------------------------------

  /** movq xmm, r64 */
  movqToX(x: number, r: R) { this.b(0x66); this.rex(true, x, r); this.b(0x0f, 0x6e); this.modrmReg(x, r); }
  /** movq r64, xmm */
  movqFromX(r: R, x: number) { this.b(0x66); this.rex(true, x, r); this.b(0x0f, 0x7e); this.modrmReg(x, r); }
  private sse(prefix: number, op: number, dst: number, src: number) { this.b(prefix); this.rex(false, dst, src); this.b(0x0f, op); this.modrmReg(dst, src); }
  addsd(d: number, s: number) { this.sse(0xf2, 0x58, d, s); }
  subsd(d: number, s: number) { this.sse(0xf2, 0x5c, d, s); }
  mulsd(d: number, s: number) { this.sse(0xf2, 0x59, d, s); }
  divsd(d: number, s: number) { this.sse(0xf2, 0x5e, d, s); }
  ucomisd(d: number, s: number) { this.sse(0x66, 0x2e, d, s); }
  /** Round a double to float precision and back (for f32 arithmetic). */
  roundToF32(x: number) { this.sse(0xf2, 0x5a, x, x); this.sse(0xf3, 0x5a, x, x); }

  // ---------------------------------------------------------------------
  // Control flow
  // ---------------------------------------------------------------------

  jmp(l: Label) { this.b(0xe9); const at = this.pos; this.d32(0); this.fixups.push({ at, next: this.pos, target: l }); }
  jcc(cc: CC, l: Label) { this.b(0x0f, 0x80 + cc); const at = this.pos; this.d32(0); this.fixups.push({ at, next: this.pos, target: l }); }
  call(target: Label | { abs: string }) { this.b(0xe8); const at = this.pos; this.d32(0); this.fixups.push({ at, next: this.pos, target }); }
  /** call qword [rip + target] (calls through an import table slot) */
  callRipMem(target: Label | { abs: string }) { this.b(0xff); this.modrmRip(2, target); }
  ret() { this.b(0xc3); }
  syscall() { this.b(0x0f, 0x05); }
  ud2() { this.b(0x0f, 0x0b); }

  /**
   * Resolve every fixup. `base` is the image address of byte 0 of this code;
   * `abs` maps external names (runtime functions, data) to image addresses.
   */
  link(base: number, abs: (name: string) => number) {
    for (const f of this.fixups) {
      const target = "id" in f.target ? base + this.labelOffset(f.target) : abs(f.target.abs);
      const rel = target - (base + f.next);
      this.bytes[f.at] = rel & 0xff;
      this.bytes[f.at + 1] = (rel >> 8) & 0xff;
      this.bytes[f.at + 2] = (rel >> 16) & 0xff;
      this.bytes[f.at + 3] = (rel >> 24) & 0xff;
    }
  }
}
