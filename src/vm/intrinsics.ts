/**
 * # Intrinsics: the bottom of the standard library
 *
 * Functions the std library declares without a body (like
 * `pub fn push(&mut self, value: T);`) are implemented here, in TypeScript.
 * The code generator emits `INTRINSIC <name> <argc>`; the VM looks the name
 * up in this table.
 *
 * Methods receive `self` the way Rust passes it: `&self`/`&mut self` arrive as
 * a {@link Ref} (or, for `&str`, the string itself), and `self` by value
 * arrives as the value.
 */
import { Agg, Exit, NONE, Panic, Ref, RMap, RString, RVec, byteToIndex, indexToByte, keyOf, some, utf8Len, type Value } from "./values.ts";

export interface IntrinsicContext {
  clone(v: Value, ty: number): Value;
}

type Intrinsic = (args: Value[], ctx: IntrinsicContext) => Value;

const panic = (msg: string): never => {
  throw new Panic(msg);
};

const deref = (v: Value): Value => (v instanceof Ref ? v.get() : v);
const vec = (v: Value): RVec => deref(v) as RVec;
const rstr = (v: Value): RString => deref(v) as RString;
const map = (v: Value): RMap => deref(v) as RMap;
/** A `&str` argument: a JS string, or a reference to a `String`. */
const str = (v: Value): string => {
  const d = deref(v);
  return typeof d === "string" ? d : (d as RString).s;
};

function boundary(s: string, byte: number, what = "byte index"): number {
  if (byte > utf8Len(s)) panic(`${what} ${byte} is out of bounds of \`${s}\``);
  const i = byteToIndex(s, byte);
  if (i < 0) panic(`${what} ${byte} is not a char boundary`);
  return i;
}

// ---------------------------------------------------------------------------
// Integers: range checks, wrapping
// ---------------------------------------------------------------------------

export const INT_BITS: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, i128: 128, isize: 64, u8: 8, u16: 16, u32: 32, u64: 64, u128: 128, usize: 64 };

export function intRange(name: string): [number, number] {
  const bits = INT_BITS[name];
  const signed = name.startsWith("i");
  if (bits >= 53) return signed ? [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] : [0, Number.MAX_SAFE_INTEGER];
  return signed ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1] : [0, 2 ** bits - 1];
}

export function wrapInt(v: number, name: string): number {
  const bits = INT_BITS[name];
  const big = BigInt(Math.trunc(v));
  const w = name.startsWith("i") ? BigInt.asIntN(bits, big) : BigInt.asUintN(bits, big);
  return Number(w);
}

function checked(v: number, name: string): Value {
  const [lo, hi] = intRange(name);
  return Number.isFinite(v) && v >= lo && v <= hi ? some(v) : NONE();
}

function saturate(v: number, name: string): number {
  const [lo, hi] = intRange(name);
  return Math.min(hi, Math.max(lo, v));
}

function parseIntStrict(s: string, name: string): Value {
  const signed = name.startsWith("i");
  if (!(signed ? /^[+-]?\d+$/ : /^\+?\d+$/).test(s)) return NONE();
  const n = Number(s);
  return checked(n, name);
}

function intIntrinsics(t: string): Record<string, Intrinsic> {
  const [lo, hi] = intRange(t);
  const chk = (v: number, what: string) => (v < lo || v > hi || !Number.isFinite(v) ? panic(`attempt to ${what} with overflow`) : v);
  return {
    [`${t}::pow`]: ([a, e]) => chk((a as number) ** (e as number), "multiply"),
    [`${t}::checked_add`]: ([a, b]) => checked((a as number) + (b as number), t),
    [`${t}::checked_sub`]: ([a, b]) => checked((a as number) - (b as number), t),
    [`${t}::checked_mul`]: ([a, b]) => checked((a as number) * (b as number), t),
    [`${t}::checked_div`]: ([a, b]) => ((b as number) === 0 ? NONE() : checked(Math.trunc((a as number) / (b as number)), t)),
    [`${t}::wrapping_add`]: ([a, b]) => wrapInt((a as number) + (b as number), t),
    [`${t}::wrapping_sub`]: ([a, b]) => wrapInt((a as number) - (b as number), t),
    [`${t}::wrapping_mul`]: ([a, b]) => {
      const big = BigInt(a as number) * BigInt(b as number);
      return Number(t.startsWith("i") ? BigInt.asIntN(INT_BITS[t], big) : BigInt.asUintN(INT_BITS[t], big));
    },
    [`${t}::saturating_add`]: ([a, b]) => saturate((a as number) + (b as number), t),
    [`${t}::saturating_sub`]: ([a, b]) => saturate((a as number) - (b as number), t),
    [`${t}::rem_euclid`]: ([a, b]) => {
      if ((b as number) === 0) panic("attempt to calculate the remainder with a divisor of zero");
      const r = (a as number) % (b as number);
      return r < 0 ? r + Math.abs(b as number) : r;
    },
    // Like std: abs/signum only for signed types, is_power_of_two only for unsigned.
    ...(t.startsWith("i")
      ? {
        [`${t}::abs`]: ([a]: Value[]) => chk(Math.abs(a as number), "negate"),
        [`${t}::signum`]: ([a]: Value[]) => Math.sign(a as number),
      }
      : { [`${t}::is_power_of_two`]: ([a]: Value[]) => (a as number) > 0 && Number.isInteger(Math.log2(a as number)) }),
    [`num::parse_${t}`]: ([s]) => parseIntStrict(str(s), t),
  };
}

function floatIntrinsics(t: string): Record<string, Intrinsic> {
  const f = (x: number) => (t === "f32" ? Math.fround(x) : x);
  const n = (v: Value) => v as number;
  return {
    [`${t}::sqrt`]: ([a]) => f(Math.sqrt(n(a))),
    [`${t}::abs`]: ([a]) => Math.abs(n(a)),
    [`${t}::powi`]: ([a, b]) => f(n(a) ** n(b)),
    [`${t}::powf`]: ([a, b]) => f(n(a) ** n(b)),
    [`${t}::floor`]: ([a]) => Math.floor(n(a)),
    [`${t}::ceil`]: ([a]) => Math.ceil(n(a)),
    [`${t}::round`]: ([a]) => Math.sign(n(a)) * Math.round(Math.abs(n(a))),
    [`${t}::trunc`]: ([a]) => Math.trunc(n(a)),
    [`${t}::sin`]: ([a]) => f(Math.sin(n(a))),
    [`${t}::cos`]: ([a]) => f(Math.cos(n(a))),
    [`${t}::tan`]: ([a]) => f(Math.tan(n(a))),
    [`${t}::atan2`]: ([a, b]) => f(Math.atan2(n(a), n(b))),
    [`${t}::exp`]: ([a]) => f(Math.exp(n(a))),
    [`${t}::ln`]: ([a]) => f(Math.log(n(a))),
    [`${t}::log10`]: ([a]) => f(Math.log10(n(a))),
    [`${t}::min`]: ([a, b]) => (Number.isNaN(n(a)) ? n(b) : Number.isNaN(n(b)) ? n(a) : Math.min(n(a), n(b))),
    [`${t}::max`]: ([a, b]) => (Number.isNaN(n(a)) ? n(b) : Number.isNaN(n(b)) ? n(a) : Math.max(n(a), n(b))),
    [`${t}::is_nan`]: ([a]) => Number.isNaN(n(a)),
    [`${t}::signum`]: ([a]) => (Number.isNaN(n(a)) ? NaN : Object.is(n(a), -0) || n(a) < 0 ? -1 : 1),
    [`${t}::to_degrees`]: ([a]) => f((n(a) * 180) / Math.PI),
    [`${t}::to_radians`]: ([a]) => f((n(a) * Math.PI) / 180),
    [`num::parse_${t}`]: ([s]) => {
      const text = str(s);
      if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|NaN)$/i.test(text)) {
        const lower = text.toLowerCase().replace(/^\+/, "");
        if (lower === "inf" || lower === "infinity") return some(Infinity);
        if (lower === "-inf" || lower === "-infinity") return some(-Infinity);
        return some(f(Number(text)));
      }
      return NONE();
    },
  };
}

function hashMapIntrinsics(): Record<string, Intrinsic> {
  const find = (m: RMap, k: Value) => m.index.get(keyOf(k));
  return {
    "HashMap::new": () => new RMap(),
    "HashMap::insert": ([self, k, v]) => {
      const m = map(self);
      const i = find(m, k);
      if (i !== undefined) {
        const old = m.vals[i];
        m.vals[i] = v;
        return some(old);
      }
      m.index.set(keyOf(k), m.keys.length);
      m.keys.push(k);
      m.vals.push(v);
      m.alive.push(true);
      m.size++;
      return NONE();
    },
    "HashMap::get": ([self, k]) => {
      const m = map(self);
      const i = find(m, deref(k));
      return i === undefined ? NONE() : some(new Ref(m.vals, i));
    },
    "HashMap::get_mut": ([self, k]) => {
      const m = map(self);
      const i = find(m, deref(k));
      return i === undefined ? NONE() : some(new Ref(m.vals, i));
    },
    "HashMap::contains_key": ([self, k]) => find(map(self), deref(k)) !== undefined,
    "HashMap::remove": ([self, k]) => {
      const m = map(self);
      const key = keyOf(deref(k));
      const i = m.index.get(key);
      if (i === undefined) return NONE();
      m.index.delete(key);
      m.alive[i] = false;
      m.size--;
      return some(m.vals[i]);
    },
    "HashMap::len": ([self]) => map(self).size,
    "HashMap::clear": ([self]) => {
      const m = map(self);
      m.keys = []; m.vals = []; m.alive = []; m.index.clear(); m.size = 0;
      return undefined;
    },
    "HashMap::index_ref": ([m, k]) => {
      const i = find(m as RMap, deref(k));
      if (i === undefined) panic("key not found in HashMap");
      return new Ref((m as RMap).vals, i!);
    },
    "collections::slot_count": ([self]) => map(self).keys.length,
    "collections::slot": ([self, i]) => {
      const m = map(self);
      const idx = i as number;
      return m.alive[idx] ? some(new Agg(0, [new Ref(m.keys, idx), new Ref(m.vals, idx)])) : NONE();
    },
    "collections::entry_ref": ([self, k, dflt]) => {
      const m = map(self);
      let i = find(m, k);
      if (i === undefined) {
        i = m.keys.length;
        m.index.set(keyOf(k), i);
        m.keys.push(k);
        m.vals.push(dflt);
        m.alive.push(true);
        m.size++;
      }
      return new Ref(m.vals, i);
    },
  };
}

const charTests: Record<string, (c: string) => boolean> = {
  is_alphabetic: (c) => /\p{Alphabetic}/u.test(c),
  is_numeric: (c) => /\p{N}/u.test(c),
  is_alphanumeric: (c) => /[\p{Alphabetic}\p{N}]/u.test(c),
  is_whitespace: (c) => /\s/u.test(c),
  is_uppercase: (c) => /\p{Uppercase}/u.test(c),
  is_lowercase: (c) => /\p{Lowercase}/u.test(c),
  is_ascii_digit: (c) => /^[0-9]$/.test(c),
  is_ascii_punctuation: (c) => /^[!-\/:-@[-`{-~]$/.test(c),
};

export function buildIntrinsics(): Map<string, Intrinsic> {
  const table: Record<string, Intrinsic> = {
    // --- Vec ---
    "Vec::new": () => new RVec([]),
    "Vec::push": ([self, v]) => { vec(self).items.push(v); return undefined; },
    "Vec::pop": ([self]) => {
      const items = vec(self).items;
      return items.length ? some(items.pop()) : NONE();
    },
    "Vec::len": ([self]) => vec(self).items.length,
    "Vec::clear": ([self]) => { vec(self).items.length = 0; return undefined; },
    "Vec::insert": ([self, i, v]) => {
      const items = vec(self).items;
      if ((i as number) > items.length) panic(`insertion index (is ${i}) should be <= len (is ${items.length})`);
      items.splice(i as number, 0, v);
      return undefined;
    },
    "Vec::remove": ([self, i]) => {
      const items = vec(self).items;
      if ((i as number) >= items.length) panic(`removal index (is ${i}) should be < len (is ${items.length})`);
      return items.splice(i as number, 1)[0];
    },
    "Vec::swap": ([self, a, b]) => {
      const items = vec(self).items;
      for (const x of [a, b]) if ((x as number) >= items.length) panic(`index out of bounds: the len is ${items.length} but the index is ${x}`);
      [items[a as number], items[b as number]] = [items[b as number], items[a as number]];
      return undefined;
    },
    "Vec::truncate": ([self, n]) => { const v = vec(self); if ((n as number) < v.items.length) v.items.length = n as number; return undefined; },
    "Vec::reverse": ([self]) => { vec(self).items.reverse(); return undefined; },
    "vec::take_unchecked": ([self, i]) => vec(self).items[i as number],
    "vec::from_elems": (args) => new RVec(args),
    "vec::from_elem": ([x, n, ty], ctx) => {
      const items: Value[] = [];
      for (let i = 0; i < (n as number); i++) items.push(i === (n as number) - 1 ? x : ctx.clone(x, ty as number));
      return new RVec(items);
    },

    // --- Box ---
    "Box::new": ([v]) => [v],

    // --- String ---
    "String::new": () => new RString(""),
    "String::from": ([s]) => new RString(str(s)),
    "String::push_str": ([self, s]) => { rstr(self).s += str(s); return undefined; },
    "String::push": ([self, c]) => { rstr(self).s += c as string; return undefined; },
    "String::as_str": ([self]) => rstr(self).s,
    "String::clear": ([self]) => { rstr(self).s = ""; return undefined; },
    "String::insert": ([self, i, c]) => {
      const r = rstr(self);
      const idx = boundary(r.s, i as number);
      r.s = r.s.slice(0, idx) + (c as string) + r.s.slice(idx);
      return undefined;
    },
    "String::truncate": ([self, n]) => {
      const r = rstr(self);
      if ((n as number) < utf8Len(r.s)) r.s = r.s.slice(0, boundary(r.s, n as number, "new_len"));
      return undefined;
    },
    "String::pop": ([self]) => {
      const r = rstr(self);
      const chars = [...r.s];
      if (!chars.length) return NONE();
      const c = chars.pop()!;
      r.s = chars.join("");
      return some(c);
    },
    "String::remove": ([self, i]) => {
      const r = rstr(self);
      const idx = boundary(r.s, i as number);
      if (idx >= r.s.length) panic("cannot remove a char from the end of a string");
      const c = String.fromCodePoint(r.s.codePointAt(idx)!);
      r.s = r.s.slice(0, idx) + r.s.slice(idx + c.length);
      return c;
    },

    // --- str ---
    "str::len": ([s]) => utf8Len(str(s)),
    "str::to_uppercase": ([s]) => new RString(str(s).toUpperCase()),
    "str::to_lowercase": ([s]) => new RString(str(s).toLowerCase()),
    "str::trim": ([s]) => str(s).trim(),
    "str::trim_start": ([s]) => str(s).trimStart(),
    "str::trim_end": ([s]) => str(s).trimEnd(),
    "str::contains": ([s, p]) => str(s).includes(str(p)),
    "str::starts_with": ([s, p]) => str(s).startsWith(str(p)),
    "str::ends_with": ([s, p]) => str(s).endsWith(str(p)),
    "str::find": ([s, p]) => {
      const i = str(s).indexOf(str(p));
      return i < 0 ? NONE() : some(indexToByte(str(s), i));
    },
    "str::replace": ([s, a, b]) => new RString(str(s).split(str(a)).join(str(b))),
    "str::repeat": ([s, n]) => new RString(str(s).repeat(n as number)),
    "str::char_count": ([s]) => [...str(s)].length,
    "str::slice": ([s, a, b]) => {
      const text = str(s);
      if ((a as number) > (b as number)) panic(`begin <= end (${a} <= ${b}) when slicing \`${text}\``);
      return text.slice(boundary(text, a as number), boundary(text, b as number));
    },
    "str::split_whitespace_vec": ([s]) => new RVec(str(s).split(/\s+/).filter((x) => x.length > 0)),
    "str::split_vec": ([s, sep]) => new RVec(str(s).split(str(sep))),
    "str::lines_vec": ([s]) => {
      const lines = str(s).split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      return new RVec(lines);
    },
    "str::next_char": ([s, pos]) => {
      const text = str(s);
      const p = pos as Ref;
      const idx = byteToIndex(text, p.get() as number);
      if (idx < 0 || idx >= text.length) return NONE();
      const c = String.fromCodePoint(text.codePointAt(idx)!);
      p.set((p.get() as number) + utf8Len(c));
      return some(c);
    },

    // --- fmt ---
    "fmt::push_str": ([f, s]) => { rstr(f).s += str(s); return undefined; },
    "Formatter::alternate": () => false,

    // --- mem ---
    "mem::replace": ([dest, src]) => {
      const r = dest as Ref;
      const old = r.get();
      r.set(src);
      return old;
    },
    "mem::swap": ([a, b]) => {
      const x = a as Ref, y = b as Ref;
      const t = x.get();
      x.set(y.get());
      y.set(t);
      return undefined;
    },

    // --- process ---
    "process::exit": ([code]) => { throw new Exit(code as number); },

    // --- cmp ---
    "cmp::to_ordering": ([n]) => new Agg((n as number) + 1, []),
    "cmp::to_option_ordering": ([n]) => (Number.isNaN(n as number) ? NONE() : some(new Agg((n as number) + 1, []))),

    // --- char ---
    "char::to_ascii_uppercase": ([c]) => (/^[a-z]$/.test(c as string) ? (c as string).toUpperCase() : c),
    "char::to_ascii_lowercase": ([c]) => (/^[A-Z]$/.test(c as string) ? (c as string).toLowerCase() : c),
    "char::to_digit": ([c, radix]) => {
      const d = parseInt(c as string, radix as number);
      return Number.isNaN(d) ? NONE() : some(d);
    },
    "char::len_utf8": ([c]) => utf8Len(c as string),
  };
  for (const [name, test] of Object.entries(charTests)) table[`char::${name}`] = ([c]) => test(c as string);
  for (const t of ["i8", "i16", "i32", "i64", "isize", "u8", "u16", "u32", "u64", "usize"]) Object.assign(table, intIntrinsics(t));
  for (const t of ["f32", "f64"]) Object.assign(table, floatIntrinsics(t));
  Object.assign(table, hashMapIntrinsics());
  return new Map(Object.entries(table));
}
