/**
 * # Runtime values
 *
 * How Rust values are represented while the VM runs:
 *
 * | Rust                         | VM representation                         |
 * |------------------------------|-------------------------------------------|
 * | integers, floats             | JS `number`                               |
 * | `bool`                       | JS `boolean`                              |
 * | `char`                       | one-code-point JS `string`                |
 * | `&str`                       | JS `string` (immutable, so no `Ref` needed) |
 * | `()`                         | `undefined`                               |
 * | struct, tuple, enum variant  | {@link Agg}: a tag plus an array of fields |
 * | `String`                     | {@link RString}: a mutable box around a JS string |
 * | `Vec<T>`                     | {@link RVec}                              |
 * | `Box<T>`                     | a one-element JS array `[value]`          |
 * | `HashMap<K, V>`              | {@link RMap}                              |
 * | `&T`, `&mut T`               | {@link Ref}: an array plus an index       |
 *
 * A `Ref` names a *slot*: a local variable's slot in its frame, a struct
 * field, a vector element, or a box's contents. Every one of those lives in a
 * JS array, so `Ref { base, i }` can read and write any of them uniformly.
 */

export type Value = number | boolean | string | undefined | Agg | RString | RVec | RMap | Ref | Value[];

/** A struct, tuple or enum variant. For enums, `tag` is the variant index. */
export class Agg {
  tag: number;
  f: Value[];
  constructor(tag: number, f: Value[]) {
    this.tag = tag;
    this.f = f;
  }
}

export class RString {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
}

export class RVec {
  items: Value[];
  constructor(items: Value[]) {
    this.items = items;
  }
}

/** Insertion-ordered hash map. Removed entries leave a tombstone so iteration indices stay stable. */
export class RMap {
  keys: Value[] = [];
  vals: Value[] = [];
  alive: boolean[] = [];
  index = new Map<string, number>();
  size = 0;
}

export class Ref {
  base: Value[];
  i: number;
  constructor(base: Value[], i: number) {
    this.base = base;
    this.i = i;
  }
  get(): Value {
    return this.base[this.i];
  }
  set(v: Value) {
    this.base[this.i] = v;
  }
}

/** Thrown to unwind the VM when the program panics. */
export class Panic extends Error {}

/** Thrown by `std::process::exit`. */
export class Exit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** Follow references until reaching a non-reference value. */
export function derefAll(v: Value): Value {
  while (v instanceof Ref) v = v.get();
  return v;
}

export const some = (v: Value) => new Agg(1, [v]);
export const NONE = () => new Agg(0, []);
export const ok = (v: Value) => new Agg(0, [v]);
export const err = (v: Value) => new Agg(1, [v]);

/** A string key identifying a value structurally, for hash map lookups. */
export function keyOf(v: Value): string {
  if (v instanceof Ref) return keyOf(v.get());
  if (typeof v === "number") return `n${v}`;
  if (typeof v === "string") return `s${v}`;
  if (typeof v === "boolean") return v ? "T" : "F";
  if (v === undefined) return "u";
  if (v instanceof RString) return `s${v.s}`;
  if (v instanceof Agg) return `a${v.tag}(${v.f.map(keyOf).join(",")})`;
  if (v instanceof RVec) return `v[${v.items.map(keyOf).join(",")}]`;
  if (Array.isArray(v)) return keyOf(v[0]);
  return "?";
}

// ---------------------------------------------------------------------------
// UTF-8 helpers: Rust strings are indexed by *byte* offset in UTF-8.
// ---------------------------------------------------------------------------

export function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Convert a UTF-8 byte offset into a JS string index, or -1 if it isn't on a char boundary. */
export function byteToIndex(s: string, byte: number): number {
  let b = 0;
  let i = 0;
  for (const ch of s) {
    if (b === byte) return i;
    if (b > byte) return -1;
    const cp = ch.codePointAt(0)!;
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += ch.length;
  }
  return b === byte ? i : -1;
}

export function indexToByte(s: string, index: number): number {
  return utf8Len(s.slice(0, index));
}
