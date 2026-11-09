/**
 * # Stage 9: The virtual machine
 *
 * A classic *fetch–decode–execute* loop over the bytecode:
 *
 * ```mermaid
 * flowchart LR
 *   F["fetch<br/>op = code[ip]"] --> D["decode<br/>read operands"] --> E["execute<br/>push / pop / jump / call"] --> F
 * ```
 *
 * State:
 *
 * - an **operand stack** shared by all frames;
 * - a stack of **frames**, one per active call, each with its own local slots
 *   and instruction pointer.
 *
 * `CALL f n` pops `n` arguments into a new frame's first slots; `RET` pops the
 * frame and pushes the return value for the caller. Panics unwind the whole
 * VM and report the source location of the instruction that panicked, taken
 * from each function's line table.
 */
import { NUM_KINDS, Op } from "../bytecode/opcodes.ts";
import { isStdFunction, type FunctionCode, type Program, type TypeDesc } from "../bytecode/program.ts";
import { Formatter } from "./format.ts";
import { INT_BITS, buildIntrinsics, intRange, wrapInt } from "./intrinsics.ts";
import { Agg, Exit, Panic, Ref, RMap, RString, RVec, type Value } from "./values.ts";

export interface RunOptions {
  /** Called with each chunk printed to stdout/stderr. */
  write?: (text: string, stream: "stdout" | "stderr") => void;
  /** Abort after this many instructions (protects the browser from infinite loops). */
  maxSteps?: number;
  maxDepth?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The panic message and location, if the program panicked. */
  panic?: string;
  steps: number;
}

interface Frame {
  fn: FunctionCode;
  code: number[];
  ip: number;
  locals: Value[];
  /** Operand stack height when the frame was entered. */
  base: number;
}

export function run(program: Program, opts: RunOptions = {}): RunResult {
  return new VM(program, opts).run();
}

class VM {
  private readonly stack: Value[] = [];
  private readonly frames: Frame[] = [];
  private readonly intrinsics = buildIntrinsics();
  private readonly fmt: Formatter;
  private stdout = "";
  private stderr = "";
  private steps = 0;
  private readonly program: Program;
  private readonly opts: RunOptions;
  private readonly types: TypeDesc[];

  constructor(program: Program, opts: RunOptions) {
    this.program = program;
    this.opts = opts;
    this.types = program.types;
    this.fmt = new Formatter(program.types);
  }

  private write(text: string, stream: "stdout" | "stderr") {
    if (stream === "stdout") this.stdout += text;
    else this.stderr += text;
    this.opts.write?.(text, stream);
  }

  run(): RunResult {
    try {
      this.call(this.program.entry, 0);
      this.loop();
      return { exitCode: 0, stdout: this.stdout, stderr: this.stderr, steps: this.steps };
    } catch (e) {
      if (e instanceof Exit) return { exitCode: e.code, stdout: this.stdout, stderr: this.stderr, steps: this.steps };
      if (e instanceof Panic) {
        const where = this.location();
        const msg = `thread 'main' panicked at ${where}:\n${e.message}\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace\n`;
        this.write(msg, "stderr");
        return { exitCode: 101, stdout: this.stdout, stderr: this.stderr, panic: e.message, steps: this.steps };
      }
      throw e;
    }
  }

  /** Source location of the current instruction, from the line table. */
  private location(): string {
    // Like #[track_caller]: report the innermost frame outside the standard library.
    const f = [...this.frames].reverse().find((x) => !isStdFunction(this.program, x.fn)) ?? this.frames[this.frames.length - 1];
    if (!f) return "<unknown>";
    let loc = -1;
    for (let i = 0; i < f.fn.lines.length; i += 2) {
      if (f.fn.lines[i] <= f.ip - 1) loc = f.fn.lines[i + 1];
      else break;
    }
    const l = this.program.locs[loc];
    return l ? `${l.file}:${l.line}:${l.col}` : f.fn.name;
  }

  private call(fnIndex: number, argc: number) {
    const fn = this.program.functions[fnIndex];
    if (this.frames.length >= (this.opts.maxDepth ?? 2000)) {
      throw new Panic("stack overflow: too many nested calls (infinite recursion?)");
    }
    const locals: Value[] = new Array(fn.locals);
    for (let i = argc - 1; i >= 0; i--) locals[i] = this.stack.pop();
    this.frames.push({ fn, code: fn.code, ip: 0, locals, base: this.stack.length });
  }

  private kind(k: number): string {
    return NUM_KINDS[k];
  }

  private checkInt(v: number, k: number, what: string): number {
    const name = this.kind(k);
    if (name === "f32") return Math.fround(v);
    if (name === "f64") return v;
    const [lo, hi] = intRange(name);
    if (!(v >= lo && v <= hi)) {
      if (INT_BITS[name] >= 53 && Number.isFinite(v)) throw new Panic(`attempt to ${what} with overflow (TSRust stores 64-bit integers as JavaScript numbers, exact only up to 2^53)`);
      throw new Panic(`attempt to ${what} with overflow`);
    }
    return v;
  }

  private isFloat(k: number): boolean {
    const n = this.kind(k);
    return n === "f32" || n === "f64";
  }

  private bitwise(a: Value, b: Value, k: number, f: (x: bigint, y: bigint) => bigint, fb: (x: boolean, y: boolean) => boolean): Value {
    const name = this.kind(k);
    if (name === "bool") return fb(a as boolean, b as boolean);
    const bits = INT_BITS[name];
    const r = f(BigInt(a as number), BigInt(b as number));
    return Number(name.startsWith("i") ? BigInt.asIntN(bits, r) : BigInt.asUintN(bits, r));
  }

  private loop() {
    const stack = this.stack;
    const maxSteps = this.opts.maxSteps ?? 200_000_000;
    while (this.frames.length) {
      const frame = this.frames[this.frames.length - 1];
      const code = frame.code;
      const op = code[frame.ip++];
      if (++this.steps > maxSteps) throw new Panic(`TSRust: execution stopped after ${maxSteps} instructions (infinite loop?)`);
      switch (op) {
        case Op.NOP: break;
        case Op.CONST: case Op.CONST_F: case Op.CONST_CHAR: stack.push(this.program.constants[code[frame.ip++]]); break;
        case Op.UNIT: stack.push(undefined); break;
        case Op.TRUE: stack.push(true); break;
        case Op.FALSE: stack.push(false); break;
        case Op.POP: stack.pop(); break;
        case Op.DUP: stack.push(stack[stack.length - 1]); break;

        case Op.LOAD: stack.push(frame.locals[code[frame.ip++]]); break;
        case Op.STORE: frame.locals[code[frame.ip++]] = stack.pop(); break;
        case Op.REF_LOCAL: stack.push(new Ref(frame.locals, code[frame.ip++])); break;
        case Op.LOAD_REF: {
          const r = stack.pop();
          // Only references (and &str, which is its own reference) can be dereferenced.
          if (typeof r === "number" || typeof r === "boolean" || r === undefined) throw new Error(`VM: LOAD_REF of a non-reference (${String(r)}) in ${frame.fn.name}`);
          stack.push(r instanceof Ref ? r.get() : r);
          break;
        }
        case Op.STORE_REF: {
          const v = stack.pop();
          (stack.pop() as Ref).set(v);
          break;
        }
        case Op.FIELD_REF: {
          const i = code[frame.ip++];
          const r = stack.pop() as Ref;
          stack.push(new Ref((r.get() as Agg).f, i));
          break;
        }
        case Op.DEREF_REF: {
          // `&&T` → `&T`, or `&Box<T>` → `&T`.
          const r = stack.pop() as Ref;
          const target = r.get();
          stack.push(Array.isArray(target) ? new Ref(target, 0) : target);
          break;
        }
        case Op.STR_REF: {
          let v = stack.pop();
          while (v instanceof Ref) v = v.get();
          stack.push(v instanceof RString ? v.s : v);
          break;
        }
        case Op.STR_OF: {
          const v = stack.pop();
          stack.push(v instanceof RString ? v.s : v);
          break;
        }
        case Op.INDEX_REF: {
          const i = stack.pop() as number;
          const vec = (stack.pop() as Ref).get() as RVec;
          if (i >= vec.items.length) throw new Panic(`index out of bounds: the len is ${vec.items.length} but the index is ${i}`);
          stack.push(new Ref(vec.items, i));
          break;
        }
        case Op.INDEX_GET: {
          const i = stack.pop() as number;
          const vec = stack.pop() as RVec;
          if (i >= vec.items.length) throw new Panic(`index out of bounds: the len is ${vec.items.length} but the index is ${i}`);
          stack.push(vec.items[i]);
          break;
        }

        case Op.MAKE_AGG: {
          const tag = code[frame.ip++];
          const n = code[frame.ip++];
          stack.push(new Agg(tag, stack.splice(stack.length - n, n)));
          break;
        }
        case Op.GET_FIELD: {
          const i = code[frame.ip++];
          stack.push((stack.pop() as Agg).f[i]);
          break;
        }
        case Op.GET_TAG: stack.push((stack.pop() as Agg).tag); break;
        case Op.GET_BOX: stack.push((stack.pop() as Value[])[0]); break;
        case Op.COPY: frame.ip++; stack.push(copyValue(stack.pop())); break;

        case Op.ADD: case Op.SUB: case Op.MUL: case Op.DIV: case Op.REM: {
          const k = code[frame.ip++];
          const b = stack.pop() as number, a = stack.pop() as number;
          stack.push(this.arith(op, a, b, k));
          break;
        }
        case Op.NEG: {
          const k = code[frame.ip++];
          const a = stack.pop() as number;
          stack.push(this.isFloat(k) ? -a : this.checkInt(-a, k, "negate"));
          break;
        }
        case Op.NOT: {
          const k = code[frame.ip++];
          const a = stack.pop();
          const name = this.kind(k);
          if (name === "bool") stack.push(!a);
          else stack.push(wrapInt(-(a as number) - 1, name));
          break;
        }
        case Op.BITAND: { const k = code[frame.ip++]; const b = stack.pop(), a = stack.pop(); stack.push(this.bitwise(a, b, k, (x, y) => x & y, (x, y) => x && y)); break; }
        case Op.BITOR: { const k = code[frame.ip++]; const b = stack.pop(), a = stack.pop(); stack.push(this.bitwise(a, b, k, (x, y) => x | y, (x, y) => x || y)); break; }
        case Op.BITXOR: { const k = code[frame.ip++]; const b = stack.pop(), a = stack.pop(); stack.push(this.bitwise(a, b, k, (x, y) => x ^ y, (x, y) => x !== y)); break; }
        case Op.SHL: case Op.SHR: {
          const k = code[frame.ip++];
          const b = stack.pop() as number, a = stack.pop() as number;
          const bits = INT_BITS[this.kind(k)];
          if (b < 0 || b >= bits) throw new Panic(`attempt to shift ${op === Op.SHL ? "left" : "right"} with overflow`);
          stack.push(this.bitwise(a, b, k, (x, y) => (op === Op.SHL ? x << y : x >> y), (x) => x));
          break;
        }
        case Op.CAST: {
          const from = this.kind(code[frame.ip++]);
          const to = this.kind(code[frame.ip++]);
          stack.push(castValue(stack.pop(), from, to));
          break;
        }

        case Op.EQ: { frame.ip++; const b = stack.pop(), a = stack.pop(); stack.push(a === b); break; }
        case Op.NE: { frame.ip++; const b = stack.pop(), a = stack.pop(); stack.push(a !== b); break; }
        case Op.LT: { frame.ip++; const b = stack.pop() as number, a = stack.pop() as number; stack.push(a < b); break; }
        case Op.LE: { frame.ip++; const b = stack.pop() as number, a = stack.pop() as number; stack.push(a <= b); break; }
        case Op.GT: { frame.ip++; const b = stack.pop() as number, a = stack.pop() as number; stack.push(a > b); break; }
        case Op.GE: { frame.ip++; const b = stack.pop() as number, a = stack.pop() as number; stack.push(a >= b); break; }
        case Op.DEEP_EQ: {
          const t = code[frame.ip++];
          const b = stack.pop(), a = stack.pop();
          stack.push(this.deepEq(a, b, t));
          break;
        }
        case Op.DEEP_CMP: {
          const t = code[frame.ip++];
          const b = stack.pop(), a = stack.pop();
          stack.push(this.deepCmp(a, b, t));
          break;
        }
        case Op.CLONE: stack.push(this.clone(stack.pop(), code[frame.ip++])); break;
        case Op.DEFAULT: stack.push(this.defaultValue(code[frame.ip++])); break;

        case Op.JUMP: frame.ip = code[frame.ip]; break;
        case Op.JUMP_IF_FALSE: { const t = code[frame.ip++]; if (!stack.pop()) frame.ip = t; break; }
        case Op.JUMP_IF_TRUE: { const t = code[frame.ip++]; if (stack.pop()) frame.ip = t; break; }
        case Op.CALL: {
          const fn = code[frame.ip++];
          const argc = code[frame.ip++];
          this.call(fn, argc);
          break;
        }
        case Op.RET: {
          const v = stack.pop();
          stack.length = frame.base;
          this.frames.pop();
          stack.push(v);
          break;
        }
        case Op.INTRINSIC: {
          const name = this.program.intrinsics[code[frame.ip++]];
          const argc = code[frame.ip++];
          const f = this.intrinsics.get(name);
          if (!f) throw new Panic(`TSRust: missing intrinsic \`${name}\``);
          const args = stack.splice(stack.length - argc, argc);
          stack.push(f(args, { clone: (v, t) => this.clone(v, t) }));
          break;
        }
        case Op.PANIC: {
          const m = stack.pop();
          throw new Panic(m instanceof RString ? m.s : String(m));
        }
        case Op.UNREACHABLE: throw new Panic("internal error: entered unreachable code");

        case Op.NEW_STRING: stack.push(new RString("")); break;
        case Op.STR_APPEND: {
          const s = stack.pop() as string;
          (stack.pop() as RString).s += s;
          break;
        }
        case Op.FMT: {
          const t = code[frame.ip++];
          const flags = code[frame.ip++];
          const precision = code[frame.ip++];
          const v = stack.pop();
          const target = stack.pop() as RString;
          target.s += flags & 1 ? this.fmt.debug(v, t, (flags & 2) !== 0, "", precision) : this.fmt.display(v, t, precision);
          break;
        }
        case Op.PRINT: {
          const flags = code[frame.ip++];
          const s = (stack.pop() as RString).s + (flags & 1 ? "\n" : "");
          this.write(s, flags & 2 ? "stderr" : "stdout");
          break;
        }
        default:
          throw new Error(`VM: unknown opcode ${op} at ${frame.fn.name}:${frame.ip - 1}`);
      }
    }
  }

  private arith(op: number, a: number, b: number, k: number): number {
    if (this.isFloat(k)) {
      const r = op === Op.ADD ? a + b : op === Op.SUB ? a - b : op === Op.MUL ? a * b : op === Op.DIV ? a / b : a % b;
      return this.kind(k) === "f32" ? Math.fround(r) : r;
    }
    switch (op) {
      case Op.ADD: return this.checkInt(a + b, k, "add");
      case Op.SUB: return this.checkInt(a - b, k, "subtract");
      case Op.MUL: return this.checkInt(a * b + 0, k, "multiply");
      case Op.DIV:
        if (b === 0) throw new Panic("attempt to divide by zero");
        return this.checkInt(Math.trunc(a / b) + 0, k, "divide");
      default:
        if (b === 0) throw new Panic("attempt to calculate the remainder with a divisor of zero");
        if (b === -1) { this.checkInt(-a, k, "calculate the remainder"); return 0; }
        return (a % b) + 0; // `+ 0` turns JavaScript's -0 into 0
    }
  }

  // -------------------------------------------------------------------------
  // Structural operations, used for #[derive]d impls and built-in types
  // -------------------------------------------------------------------------

  private deepEq(a: Value, b: Value, t: number): boolean {
    const d = this.types[t];
    switch (d.k) {
      case "ref": return this.deepEq(a instanceof Ref ? a.get() : a, b instanceof Ref ? b.get() : b, d.inner);
      case "box": return this.deepEq((a as Value[])[0], (b as Value[])[0], d.inner);
      case "string": return (a as RString).s === (b as RString).s;
      case "tuple": return d.elems.every((e, i) => this.deepEq((a as Agg).f[i], (b as Agg).f[i], e));
      case "struct": return d.fields.every((f, i) => this.deepEq((a as Agg).f[i], (b as Agg).f[i], f.ty));
      case "enum": {
        const x = a as Agg, y = b as Agg;
        if (x.tag !== y.tag) return false;
        return d.variants[x.tag].fields.every((f, i) => this.deepEq(x.f[i], y.f[i], f.ty));
      }
      case "vec": {
        const x = (a as RVec).items, y = (b as RVec).items;
        return x.length === y.length && x.every((v, i) => this.deepEq(v, y[i], d.elem));
      }
      case "unit": return true;
      default: return a === b;
    }
  }

  private deepCmp(a: Value, b: Value, t: number): number {
    const d = this.types[t];
    const prim = (x: Value, y: Value) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0);
    const seq = (n: number, f: (i: number) => number) => {
      for (let i = 0; i < n; i++) {
        const c = f(i);
        if (c !== 0) return c;
      }
      return 0;
    };
    switch (d.k) {
      case "ref": return this.deepCmp(a instanceof Ref ? a.get() : a, b instanceof Ref ? b.get() : b, d.inner);
      case "box": return this.deepCmp((a as Value[])[0], (b as Value[])[0], d.inner);
      case "string": return prim((a as RString).s, (b as RString).s);
      case "bool": return prim(Number(a), Number(b));
      case "char": return prim((a as string).codePointAt(0)!, (b as string).codePointAt(0)!);
      case "tuple": return seq(d.elems.length, (i) => this.deepCmp((a as Agg).f[i], (b as Agg).f[i], d.elems[i]));
      case "struct": return seq(d.fields.length, (i) => this.deepCmp((a as Agg).f[i], (b as Agg).f[i], d.fields[i].ty));
      case "enum": {
        const x = a as Agg, y = b as Agg;
        if (x.tag !== y.tag) return x.tag < y.tag ? -1 : 1;
        const fields = d.variants[x.tag].fields;
        return seq(fields.length, (i) => this.deepCmp(x.f[i], y.f[i], fields[i].ty));
      }
      case "vec": {
        const x = (a as RVec).items, y = (b as RVec).items;
        const c = seq(Math.min(x.length, y.length), (i) => this.deepCmp(x[i], y[i], d.elem));
        return c !== 0 ? c : prim(x.length, y.length);
      }
      case "unit": return 0;
      default: return prim(a, b);
    }
  }

  private clone(v: Value, t: number): Value {
    const d = this.types[t];
    switch (d.k) {
      case "string": return new RString((v as RString).s);
      case "box": return [this.clone((v as Value[])[0], d.inner)];
      case "vec": return new RVec((v as RVec).items.map((x) => this.clone(x, d.elem)));
      case "tuple": return new Agg(0, d.elems.map((e, i) => this.clone((v as Agg).f[i], e)));
      case "struct": return new Agg(0, d.fields.map((f, i) => this.clone((v as Agg).f[i], f.ty)));
      case "enum": {
        const a = v as Agg;
        return new Agg(a.tag, d.variants[a.tag].fields.map((f, i) => this.clone(a.f[i], f.ty)));
      }
      case "map": {
        const m = v as RMap, out = new RMap();
        m.keys.forEach((k, i) => {
          if (!m.alive[i]) return;
          out.index.set([...m.index.entries()].find(([, j]) => j === i)![0], out.keys.length);
          out.keys.push(this.clone(k, d.key));
          out.vals.push(this.clone(m.vals[i], d.value));
          out.alive.push(true);
          out.size++;
        });
        return out;
      }
      default: return v; // primitives and shared references are Copy
    }
  }

  private defaultValue(t: number): Value {
    const d = this.types[t];
    switch (d.k) {
      case "int": case "float": return 0;
      case "bool": return false;
      case "char": return "\0";
      case "string": return new RString("");
      case "vec": return new RVec([]);
      case "tuple": return new Agg(0, d.elems.map((e) => this.defaultValue(e)));
      default: return undefined;
    }
  }
}

/** Deep copy of a `Copy` aggregate (structs/tuples of Copy fields). */
function copyValue(v: Value): Value {
  if (v instanceof Agg) return new Agg(v.tag, v.f.map(copyValue));
  return v;
}

function castValue(v: Value, from: string, to: string): Value {
  let n: number;
  if (from === "bool") n = v ? 1 : 0;
  else if (from === "char") n = (v as string).codePointAt(0)!;
  else n = v as number;
  if (to === "char") return String.fromCodePoint(n);
  if (to === "f32") return Math.fround(n);
  if (to === "f64") return n;
  if (to === "bool") return n !== 0;
  if (from === "f32" || from === "f64") {
    // Float → int casts saturate, and NaN becomes 0.
    if (Number.isNaN(n)) return 0;
    const [lo, hi] = intRange(to);
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  }
  return wrapInt(n, to);
}
