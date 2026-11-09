/**
 * # Formatting values like Rust does
 *
 * `{}` (Display) and `{:?}` (Debug) for every type the VM knows natively,
 * guided by the runtime {@link TypeDesc} the code generator emitted.
 * Matching Rust's output exactly matters: it's what lets a learner compare
 * TSRust's output with real `rustc` output.
 */
import type { TypeDesc } from "../bytecode/program.ts";
import { Agg, Ref, RMap, RString, RVec, type Value } from "./values.ts";

/** Rust prints floats without an exponent and with the shortest round-tripping digits. */
function plainNumber(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mant, expStr] = s.split(/e/i);
  const exp = Number(expStr);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  const pointPos = (mant.replace("-", "").indexOf(".") === -1 ? mant.replace("-", "").length : mant.replace("-", "").indexOf(".")) + exp;
  let out: string;
  if (pointPos <= 0) out = "0." + "0".repeat(-pointPos) + digits;
  else if (pointPos >= digits.length) out = digits + "0".repeat(pointPos - digits.length);
  else out = digits.slice(0, pointPos) + "." + digits.slice(pointPos);
  return (neg ? "-" : "") + out;
}

export function formatFloat(n: number, debug: boolean, precision: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (precision >= 0) return n.toFixed(precision);
  if (Object.is(n, -0)) return debug ? "-0.0" : "-0";
  const s = plainNumber(n);
  if (debug && !s.includes(".")) return s + ".0";
  return s;
}

function escapeDebug(s: string, quote: '"' | "'"): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\n": out += "\\n"; break;
      case "\t": out += "\\t"; break;
      case "\r": out += "\\r"; break;
      case "\\": out += "\\\\"; break;
      case "\0": out += "\\0"; break;
      case '"': out += quote === '"' ? '\\"' : '"'; break;
      case "'": out += quote === "'" ? "\\'" : "'"; break;
      default: out += ch;
    }
  }
  return out;
}

export class Formatter {
  private readonly types: TypeDesc[];
  constructor(types: TypeDesc[]) {
    this.types = types;
  }

  display(v: Value, ty: number, precision = -1): string {
    const t = this.types[ty];
    switch (t?.k) {
      case "int": return String(v);
      case "float": return formatFloat(v as number, false, precision);
      case "bool": return String(v);
      case "char": return v as string;
      case "str": return typeof v === "string" ? v : v instanceof Ref ? this.display(v.get(), ty, precision) : String(v);
      case "string": return v instanceof RString ? v.s : String(v);
      case "ref": return this.display(v instanceof Ref ? v.get() : v, t.inner, precision);
      case "box": return this.display((v as Value[])[0], t.inner, precision);
      default: return this.debug(v, ty, false);
    }
  }

  debug(v: Value, ty: number, pretty: boolean, indent = "", precision = -1): string {
    const t = this.types[ty];
    const nl = pretty ? "\n" : "";
    const inner = indent + "    ";
    /** Render a comma-separated list, Rust-style, in compact or pretty mode. */
    const list = (open: string, close: string, items: string[]): string => {
      if (items.length === 0) return open + close;
      if (!pretty) return `${open}${items.join(", ")}${close}`;
      return `${open}${nl}${items.map((x) => `${inner}${x},${nl}`).join("")}${indent}${close}`;
    };
    if (!t) return "?";
    switch (t.k) {
      case "int": return String(v);
      case "float": return formatFloat(v as number, true, precision);
      case "bool": return String(v);
      case "char": return `'${escapeDebug(v as string, "'")}'`;
      case "str": return `"${escapeDebug(typeof v === "string" ? v : String(v), '"')}"`;
      case "string": return `"${escapeDebug((v as RString).s, '"')}"`;
      case "unit": return "()";
      case "never": return "!";
      case "ref": return this.debug(v instanceof Ref ? v.get() : v, t.inner, pretty, indent, precision);
      case "box": return this.debug((v as Value[])[0], t.inner, pretty, indent, precision);
      case "tuple": {
        const a = v as Agg;
        const items = t.elems.map((e, i) => this.debug(a.f[i], e, pretty, inner, precision));
        if (items.length === 1 && !pretty) return `(${items[0]},)`;
        return list("(", ")", items);
      }
      case "vec": {
        const vec = v as RVec;
        return list("[", "]", vec.items.map((x) => this.debug(x, t.elem, pretty, inner, precision)));
      }
      case "map": {
        const m = v as RMap;
        const items: string[] = [];
        m.keys.forEach((k, i) => {
          if (m.alive[i]) items.push(`${this.debug(k, t.key, pretty, inner, precision)}: ${this.debug(m.vals[i], t.value, pretty, inner, precision)}`);
        });
        return list("{", "}", items);
      }
      case "struct": return this.debugFields(t.name, t.kind, t.fields, (v as Agg).f, pretty, indent, precision);
      case "enum": {
        const a = v as Agg;
        const variant = t.variants[a.tag];
        return this.debugFields(variant.name, variant.kind, variant.fields, a.f, pretty, indent, precision);
      }
      case "opaque": return `<${t.name}>`;
    }
  }

  private debugFields(name: string, kind: "named" | "tuple" | "unit", fields: { name: string; ty: number }[], values: Value[], pretty: boolean, indent: string, precision: number): string {
    if (kind === "unit") return name;
    const inner = indent + "    ";
    const parts = fields.map((f, i) => {
      const val = this.debug(values[i], f.ty, pretty, inner, precision);
      return kind === "named" ? `${f.name}: ${val}` : val;
    });
    if (parts.length === 0) return kind === "named" ? name : `${name}`;
    if (!pretty) return kind === "named" ? `${name} { ${parts.join(", ")} }` : `${name}(${parts.join(", ")})`;
    const body = parts.map((p) => `${inner}${p},\n`).join("");
    return kind === "named" ? `${name} {\n${body}${indent}}` : `${name}(\n${body}${indent})`;
  }
}
