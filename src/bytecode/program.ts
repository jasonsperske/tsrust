/**
 * # A compiled program
 *
 * The code generator produces a {@link Program}; the writer serializes it to
 * bytes; the reader turns bytes back into a `Program`; the VM executes one.
 */
import { OPS } from "./opcodes.ts";

/**
 * Runtime type descriptions. The VM needs them for structural operations
 * (printing `{:?}`, deriving `Clone`/`PartialEq`, hashing map keys).
 * Descriptors refer to each other by index into {@link Program.types}.
 */
export type TypeDesc =
  | { k: "int"; name: string }
  | { k: "float"; name: string }
  | { k: "bool" }
  | { k: "char" }
  | { k: "str" }
  | { k: "string" }
  | { k: "unit" }
  | { k: "never" }
  | { k: "tuple"; elems: number[] }
  | { k: "ref"; inner: number }
  | { k: "box"; inner: number }
  | { k: "vec"; elem: number }
  | { k: "map"; key: number; value: number }
  | { k: "struct"; name: string; kind: "named" | "tuple" | "unit"; fields: { name: string; ty: number }[] }
  | { k: "enum"; name: string; variants: { name: string; kind: "named" | "tuple" | "unit"; fields: { name: string; ty: number }[] }[] }
  | { k: "opaque"; name: string };

export interface SourceLoc {
  file: string;
  line: number;
  col: number;
}

export interface FunctionCode {
  name: string;
  params: number;
  locals: number;
  code: number[];
  /** Pairs `[codeOffset, locIndex]`, sorted by offset: where each source location starts. */
  lines: number[];
}

export interface Program {
  constants: (number | string)[];
  types: TypeDesc[];
  intrinsics: string[];
  locs: SourceLoc[];
  functions: FunctionCode[];
  entry: number;
}

/** Is this function part of the standard library? (Its source locations are in std's files.) */
export function isStdFunction(p: Program, f: FunctionCode): boolean {
  return f.lines.length > 0 && p.locs[f.lines[1]]?.file.startsWith("__std__/") === true;
}

/** Human-readable listing of a program's bytecode. */
export function disassemble(p: Program, only?: (f: FunctionCode) => boolean): string {
  const out: string[] = [];
  p.functions.forEach((f, fi) => {
    if (only && !only(f)) return;
    out.push(`fn #${fi} ${f.name}  (params: ${f.params}, locals: ${f.locals})`);
    let lineIdx = 0;
    for (let ip = 0; ip < f.code.length; ) {
      while (lineIdx < f.lines.length && f.lines[lineIdx] <= ip) {
        const loc = p.locs[f.lines[lineIdx + 1]];
        if (loc) out.push(`        ; ${loc.file}:${loc.line}:${loc.col}`);
        lineIdx += 2;
      }
      const op = OPS[f.code[ip]];
      if (!op) { out.push(`  ${String(ip).padStart(4)}  ??? ${f.code[ip]}`); ip++; continue; }
      const args = f.code.slice(ip + 1, ip + 1 + op.operands.length);
      const shown = args.map((a, i) => describeOperand(p, op.operands[i], a));
      out.push(`  ${String(ip).padStart(4)}  ${op.name.padEnd(14)}${shown.join(" ")}`);
      ip += 1 + op.operands.length;
    }
    out.push("");
  });
  return out.join("\n");
}

function describeOperand(p: Program, kind: string, v: number): string {
  switch (kind) {
    case "const": {
      const c = p.constants[v];
      return typeof c === "string" ? JSON.stringify(c.length > 40 ? c.slice(0, 40) + "…" : c) : String(c);
    }
    case "fn": return `#${v} <${p.functions[v]?.name ?? "?"}>`;
    case "intrinsic": return `<${p.intrinsics[v]}>`;
    case "type": return `type#${v}`;
    case "target": return `-> ${v}`;
    case "num": case "from": case "to": return ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "bool", "char", "str"][v] ?? String(v);
    default: return String(v);
  }
}
