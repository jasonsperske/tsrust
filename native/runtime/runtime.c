/*
 * TSRust native runtime: memory, strings, I/O, panics, and the operations the
 * native backend calls for bytecode instructions it doesn't inline.
 */
#include "runtime.h"

/* ------------------------------------------------------------------------ */
/* Host interface and program metadata                                        */
/* ------------------------------------------------------------------------ */

static host_write_fn host_write;
static host_exit_fn host_exit;
static host_alloc_fn host_alloc;
static const u8 *meta_base;
static const Meta *meta;

/* The source location of the code currently running, as a Str. Generated
 * code updates it at each statement so panics can say where they happened. */
EXPORT const Str *rt_loc;

EXPORT void rt_init(host_write_fn w, host_exit_fn e, host_alloc_fn a, const Meta *m) {
  host_write = w;
  host_exit = e;
  host_alloc = a;
  meta = m;
  meta_base = (const u8 *)m;
  /* String constants store their bytes' position *relative* to themselves, so
   * the executable needs no relocations wherever the OS loads it. Turn those
   * offsets into real pointers once, at startup. */
  Str *strings = (Str *)(meta_base + m->strings);
  for (u32 i = 0; i < m->nstrings; i++) strings[i].ptr = (const u8 *)&strings[i] + (i64)strings[i].ptr;
}

/* Float remainder (`%` on f32/f64), using the x87 FPU's partial remainder instruction. */
EXPORT V rt_frem(V a, V b) {
  long double x = as_f64(a), y = as_f64(b), r;
  __asm__("1: fprem\n\tfnstsw %%ax\n\ttestb $4, %%ah\n\tjnz 1b" : "=t"(r) : "0"(x), "u"(y) : "ax");
  return from_f64((double)r);
}

const u32 *rt_type(V td) {
  const u32 *offsets = (const u32 *)(meta_base + meta->type_offsets);
  const u32 *data = (const u32 *)(meta_base + meta->type_data);
  return data + offsets[td];
}

Str rt_name(u32 off) {
  const u8 *p = meta_base + meta->names + off;
  Str s;
  s.len = *(const u32 *)p;
  s.ptr = p + 4;
  return s;
}

/* GCC may emit calls to these even in freestanding code. */
void *memcpy(void *d, const void *s, u64 n) {
  u8 *dd = d;
  const u8 *ss = s;
  while (n--) *dd++ = *ss++;
  return d;
}
void *memmove(void *d, const void *s, u64 n) {
  u8 *dd = d;
  const u8 *ss = s;
  if (dd < ss) while (n--) *dd++ = *ss++;
  else { dd += n; ss += n; while (n--) *--dd = *--ss; }
  return d;
}
void *memset(void *d, int c, u64 n) {
  u8 *dd = d;
  while (n--) *dd++ = (u8)c;
  return d;
}
int memcmp(const void *a, const void *b, u64 n) {
  const u8 *x = a, *y = b;
  for (u64 i = 0; i < n; i++) if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
void *rt_memcpy(void *d, const void *s, u64 n) { return memcpy(d, s, n); }

/* ------------------------------------------------------------------------ */
/* Memory: a bump allocator over chunks from the OS. Nothing is ever freed;   */
/* TSRust doesn't run destructors.                                            */
/* ------------------------------------------------------------------------ */

static u8 *heap_ptr, *heap_end;

void *rt_alloc(u64 size) {
  size = (size + 15) & ~(u64)15;
  if (heap_ptr == 0 || (u64)(heap_end - heap_ptr) < size) {
    u64 chunk = size > (4u << 20) ? size : (4u << 20);
    heap_ptr = host_alloc(chunk);
    /* Raw mmap returns -errno on Linux (and -1 via the shims elsewhere): any small negative value is an error. */
    if (!heap_ptr || ((i64)heap_ptr < 0 && (i64)heap_ptr > -4096)) {
      host_write(2, (const u8 *)"memory allocation failed\n", 25);
      host_exit(134);
    }
    heap_end = heap_ptr + chunk;
  }
  void *p = heap_ptr;
  heap_ptr += size;
  return p;
}

/* ------------------------------------------------------------------------ */
/* Output, with a line buffer for stdout like Rust's                          */
/* ------------------------------------------------------------------------ */

static u8 out_buf[4096];
static u64 out_len;

static void flush_stdout(void) {
  if (out_len) host_write(1, out_buf, out_len);
  out_len = 0;
}

static void write_stdout(const u8 *p, u64 n) {
  if (n > sizeof out_buf) { flush_stdout(); host_write(1, p, n); return; }
  if (out_len + n > sizeof out_buf) flush_stdout();
  memcpy(out_buf + out_len, p, n);
  out_len += n;
}

static void write_stderr(const u8 *p, u64 n) {
  flush_stdout();
  host_write(2, p, n);
}

EXPORT NORETURN void rt_exit(i64 code) {
  flush_stdout();
  host_exit(code);
  for (;;) {}
}

/* ------------------------------------------------------------------------ */
/* Strings and vectors                                                       */
/* ------------------------------------------------------------------------ */

StringBuf *sb_new(void) {
  StringBuf *s = rt_alloc(sizeof *s);
  s->len = 0;
  s->cap = 16;
  s->ptr = rt_alloc(16);
  return s;
}

static void sb_reserve(StringBuf *s, u64 extra) {
  if (s->len + extra <= s->cap) return;
  u64 cap = s->cap * 2;
  if (cap < s->len + extra) cap = s->len + extra;
  u8 *p = rt_alloc(cap);
  memcpy(p, s->ptr, s->len);
  s->ptr = p;
  s->cap = cap;
}

void sb_push(StringBuf *s, const u8 *p, u64 n) {
  sb_reserve(s, n);
  memcpy(s->ptr + s->len, p, n);
  s->len += n;
}

void sb_push_cstr(StringBuf *s, const char *c) {
  u64 n = 0;
  while (c[n]) n++;
  sb_push(s, (const u8 *)c, n);
}

u64 utf8_encode(u32 cp, u8 *o) {
  if (cp < 0x80) { o[0] = (u8)cp; return 1; }
  if (cp < 0x800) { o[0] = 0xC0 | (cp >> 6); o[1] = 0x80 | (cp & 63); return 2; }
  if (cp < 0x10000) { o[0] = 0xE0 | (cp >> 12); o[1] = 0x80 | ((cp >> 6) & 63); o[2] = 0x80 | (cp & 63); return 3; }
  o[0] = 0xF0 | (cp >> 18); o[1] = 0x80 | ((cp >> 12) & 63); o[2] = 0x80 | ((cp >> 6) & 63); o[3] = 0x80 | (cp & 63);
  return 4;
}

void sb_push_char(StringBuf *s, u32 cp) {
  u8 b[4];
  sb_push(s, b, utf8_encode(cp, b));
}

Str *str_new(const u8 *p, u64 n) {
  Str *s = rt_alloc(sizeof *s);
  u8 *copy = rt_alloc(n ? n : 1);
  memcpy(copy, p, n);
  s->len = n;
  s->ptr = copy;
  return s;
}

Vec *vec_new(u64 cap) {
  Vec *v = rt_alloc(sizeof *v);
  v->len = 0;
  v->cap = cap ? cap : 4;
  v->data = rt_alloc(v->cap * 8);
  return v;
}

void vec_push(Vec *v, V x) {
  if (v->len == v->cap) {
    u64 cap = v->cap * 2;
    V *d = rt_alloc(cap * 8);
    memcpy(d, v->data, v->len * 8);
    v->data = d;
    v->cap = cap;
  }
  v->data[v->len++] = x;
}

V agg_new(u32 tag, u32 n) {
  Agg *a = rt_alloc(8 + 8 * (u64)n);
  a->tag = tag;
  a->n = n;
  return (V)a;
}

V some(V x) { V a = agg_new(1, 1); ((Agg *)a)->f[0] = x; return a; }
V none(void) { return agg_new(0, 0); }

/* ------------------------------------------------------------------------ */
/* Panics                                                                     */
/* ------------------------------------------------------------------------ */

NORETURN void rt_panic_str(const u8 *msg, u64 len) {
  StringBuf *s = sb_new();
  sb_push_cstr(s, "thread 'main' panicked at ");
  if (rt_loc) sb_push(s, rt_loc->ptr, rt_loc->len);
  else sb_push_cstr(s, "<unknown>");
  sb_push_cstr(s, ":\n");
  sb_push(s, msg, len);
  sb_push_cstr(s, "\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n");
  write_stderr(s->ptr, s->len);
  rt_exit(101);
}

NORETURN void rt_panic_cstr(const char *msg) {
  u64 n = 0;
  while (msg[n]) n++;
  rt_panic_str((const u8 *)msg, n);
}

/* Panic kinds for checks the backend emits inline; must match compile.ts. */
EXPORT NORETURN void rt_panic_kind(i64 kind) {
  switch (kind) {
    case 0: rt_panic_cstr("attempt to add with overflow");
    case 1: rt_panic_cstr("attempt to subtract with overflow");
    case 2: rt_panic_cstr("attempt to multiply with overflow");
    case 3: rt_panic_cstr("attempt to divide with overflow");
    case 4: rt_panic_cstr("attempt to calculate the remainder with overflow");
    case 5: rt_panic_cstr("attempt to negate with overflow");
    case 6: rt_panic_cstr("attempt to shift left with overflow");
    case 7: rt_panic_cstr("attempt to shift right with overflow");
    case 8: rt_panic_cstr("attempt to divide by zero");
    case 9: rt_panic_cstr("attempt to calculate the remainder with a divisor of zero");
    default: rt_panic_cstr("internal error: entered unreachable code");
  }
}

/* PANIC instruction: sp[0] is a &str or String (both start with len, ptr). */
EXPORT NORETURN void rt_panic(V *sp) {
  const Str *m = (const Str *)sp[0];
  rt_panic_str(m->ptr, m->len);
}

EXPORT NORETURN void rt_index_fail(V len, V index) {
  StringBuf *s = sb_new();
  sb_push_cstr(s, "index out of bounds: the len is ");
  fmt_u64(s, len);
  sb_push_cstr(s, " but the index is ");
  fmt_u64(s, index);
  rt_panic_str(s->ptr, s->len);
}

/* ------------------------------------------------------------------------ */
/* Instructions implemented in C                                             */
/* ------------------------------------------------------------------------ */

/* MAKE_AGG tag n: the n fields are sp[n-1] .. sp[0]. */
EXPORT V rt_make_agg(V *sp, i64 tag, i64 n) {
  V a = agg_new((u32)tag, (u32)n);
  for (i64 i = 0; i < n; i++) ((Agg *)a)->f[i] = sp[n - 1 - i];
  return a;
}

EXPORT V rt_copy(V *sp, i64 td) { return copy_value(sp[0], td); }
EXPORT V rt_deep_eq(V *sp, i64 td) { return deep_eq(sp[1], sp[0], td); }
EXPORT V rt_deep_cmp(V *sp, i64 td) { return (V)deep_cmp(sp[1], sp[0], td); }
EXPORT V rt_clone(V *sp, i64 td) { return deep_clone(sp[0], td); }
EXPORT V rt_new_string(void) { return (V)sb_new(); }

EXPORT V rt_str_append(V *sp) {
  const Str *s = (const Str *)sp[0];
  sb_push((StringBuf *)sp[1], s->ptr, s->len);
  return 0;
}

EXPORT V rt_fmt(V *sp, i64 td, i64 flags, i64 prec) {
  fmt_value((StringBuf *)sp[1], sp[0], td, flags & 1, (flags & 2) != 0, prec, 0);
  return 0;
}

EXPORT V rt_print(V *sp, i64 flags) {
  StringBuf *s = (StringBuf *)sp[0];
  if (flags & 2) {
    write_stderr(s->ptr, s->len);
    if (flags & 1) write_stderr((const u8 *)"\n", 1);
  } else {
    write_stdout(s->ptr, s->len);
    if (flags & 1) { write_stdout((const u8 *)"\n", 1); flush_stdout(); }
  }
  return 0;
}

/* EQ/NE/LT... on &str (kind str): returns -1, 0 or 1. */
EXPORT V rt_str_cmp(V *sp) {
  const Str *a = (const Str *)sp[1], *b = (const Str *)sp[0];
  u64 n = a->len < b->len ? a->len : b->len;
  for (u64 i = 0; i < n; i++) if (a->ptr[i] != b->ptr[i]) return (V)(a->ptr[i] < b->ptr[i] ? -1 : 1);
  return (V)(a->len < b->len ? -1 : a->len > b->len ? 1 : 0);
}

EXPORT V rt_default(i64 td) {
  const u32 *t = rt_type(td);
  switch (t[0]) {
    case T_STRING: return (V)sb_new();
    case T_VEC: return (V)vec_new(4);
    case T_TUPLE: {
      V a = agg_new(0, t[1]);
      for (u32 i = 0; i < t[1]; i++) ((Agg *)a)->f[i] = rt_default(t[2 + i]);
      return a;
    }
    case T_FLOAT: return from_f64(0.0);
    default: return 0;
  }
}

/* ------------------------------------------------------------------------ */
/* Numeric casts (`as`)                                                       */
/* ------------------------------------------------------------------------ */

static int kind_bits(i64 k) {
  switch (k) {
    case K_I8: case K_U8: return 8;
    case K_I16: case K_U16: return 16;
    case K_I32: case K_U32: case K_CHAR: return 32;
    case K_BOOL: return 1;
    default: return 64;
  }
}
static int kind_signed(i64 k) { return k <= K_ISIZE; }

/* Normalize a 64-bit pattern to integer kind k (wrapping like Rust's `as`). */
static V wrap_int(V v, i64 k) {
  int bits = kind_bits(k);
  if (bits >= 64) return v;
  if (k == K_BOOL) return v & 1;
  V mask = ((V)1 << bits) - 1;
  v &= mask;
  if (kind_signed(k) && (v >> (bits - 1))) v |= ~mask;
  return v;
}

EXPORT V rt_cast(V v, i64 from, i64 to) {
  int from_float = from == K_F32 || from == K_F64;
  int to_float = to == K_F32 || to == K_F64;
  if (from_float && to_float) return to == K_F32 ? from_f64((double)(float)as_f64(v)) : v;
  if (from_float) {
    double d = as_f64(v);
    if (d != d) return 0; /* NaN */
    if (to == K_U64 || to == K_USIZE) {
      if (d <= 0) return 0;
      if (d >= 18446744073709551615.0) return ~(V)0;
      return (V)d;
    }
    if (to == K_I64 || to == K_ISIZE) {
      if (d <= -9223372036854775808.0) return (V)0x8000000000000000ull;
      if (d >= 9223372036854775807.0) return 0x7fffffffffffffffull;
      return (V)(i64)d;
    }
    int bits = kind_bits(to);
    double lo = kind_signed(to) ? -(double)((V)1 << (bits - 1)) : 0;
    double hi = kind_signed(to) ? (double)(((V)1 << (bits - 1)) - 1) : (double)(((V)1 << bits) - 1);
    if (d < lo) d = lo;
    if (d > hi) d = hi;
    return wrap_int((V)(i64)d, to);
  }
  if (to_float) {
    double d = kind_signed(from) ? (double)(i64)v : (double)v;
    return to == K_F32 ? from_f64((double)(float)d) : from_f64(d);
  }
  if (to == K_CHAR) return v & 0xff; /* only u8 as char is allowed */
  return wrap_int(v, to);
}
