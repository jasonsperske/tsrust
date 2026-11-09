/*
 * TSRust native runtime: intrinsics, the body-less functions of the standard
 * library (`pub fn push(&mut self, value: T);`). This file is the native twin
 * of src/vm/intrinsics.ts.
 *
 * Each intrinsic is `V rt_i_<name>(V *sp, i64 argc)`, where `<name>` is the
 * intrinsic's name with `::` replaced by `__` (e.g. `Vec::push` is
 * rt_i_Vec__push). Arguments are on the operand stack: A(0) is the first
 * argument, A(argc-1) the last. `&self` arrives as the address of the slot
 * holding the value; `&str` arrives as a Str pointer.
 */
#include "runtime.h"

#define A(i) (sp[argc - 1 - (i)])
#define INTRINSIC(name) EXPORT V rt_i_##name(V *sp, i64 argc)
#define SELF(T) (*(T **)A(0))
#define UNUSED (void)sp; (void)argc

/* ------------------------------------------------------------------------ */
/* UTF-8                                                                     */
/* ------------------------------------------------------------------------ */

/* Decode the char at byte offset *i, advancing *i. */
static u32 utf8_next(const u8 *p, u64 n, u64 *i) {
  u8 c = p[*i];
  u32 cp;
  int len;
  if (c < 0x80) { cp = c; len = 1; }
  else if ((c >> 5) == 6) { cp = c & 31; len = 2; }
  else if ((c >> 4) == 14) { cp = c & 15; len = 3; }
  else { cp = c & 7; len = 4; }
  for (int k = 1; k < len && *i + k < n; k++) cp = (cp << 6) | (p[*i + k] & 63);
  *i += len;
  return cp;
}

static int is_boundary(const Str *s, u64 i) { return i == s->len || (i < s->len && (s->ptr[i] & 0xC0) != 0x80); }

static Str *str_view(const u8 *p, u64 n) {
  Str *s = rt_alloc(sizeof *s);
  s->len = n;
  s->ptr = p;
  return s;
}

static void check_boundary(const Str *s, u64 i, const char *what) {
  if (i > s->len || !is_boundary(s, i)) {
    StringBuf *m = sb_new();
    sb_push_cstr(m, what);
    sb_push_cstr(m, " ");
    fmt_u64(m, i);
    sb_push_cstr(m, i > s->len ? " is out of bounds of `" : " is not a char boundary of `");
    sb_push(m, s->ptr, s->len);
    sb_push_cstr(m, "`");
    rt_panic_str(m->ptr, m->len);
  }
}

/* ------------------------------------------------------------------------ */
/* Characters (Unicode support covers Latin, Greek and Cyrillic case mapping) */
/* ------------------------------------------------------------------------ */

static u32 to_upper(u32 c) {
  if (c >= 'a' && c <= 'z') return c - 32;
  if ((c >= 0xE0 && c <= 0xFE && c != 0xF7)) return c - 32;
  if (c == 0xFF) return 0x178;
  if (c >= 0x100 && c <= 0x17F && (c & 1)) return c - 1;
  if (c >= 0x3B1 && c <= 0x3C9 && c != 0x3C2) return c - 32;
  if (c == 0x3C2) return 0x3A3;
  if (c >= 0x430 && c <= 0x44F) return c - 32;
  if (c >= 0x450 && c <= 0x45F) return c - 80;
  return c;
}

static u32 to_lower(u32 c) {
  if (c >= 'A' && c <= 'Z') return c + 32;
  if ((c >= 0xC0 && c <= 0xDE && c != 0xD7)) return c + 32;
  if (c == 0x178) return 0xFF;
  if (c >= 0x100 && c <= 0x17F && !(c & 1)) return c + 1;
  if (c >= 0x391 && c <= 0x3A9) return c + 32;
  if (c >= 0x410 && c <= 0x42F) return c + 32;
  if (c >= 0x400 && c <= 0x40F) return c + 80;
  return c;
}

static int is_upper(u32 c) { return to_lower(c) != c; }
static int is_lower(u32 c) { return to_upper(c) != c || c == 0xDF; }

static int is_alpha(u32 c) {
  if ((c | 32) >= 'a' && (c | 32) <= 'z') return 1;
  if (c < 0xC0) return c == 0xAA || c == 0xB5 || c == 0xBA;
  if (c <= 0x24F) return c != 0xD7 && c != 0xF7;
  return (c >= 0x370 && c <= 0x3FF) || (c >= 0x400 && c <= 0x52F) || (c >= 0x5D0 && c <= 0x5EA) ||
         (c >= 0x620 && c <= 0x64A) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0x4E00 && c <= 0x9FFF) ||
         (c >= 0xAC00 && c <= 0xD7A3);
}

static int is_digit(u32 c) { return (c >= '0' && c <= '9') || (c >= 0x660 && c <= 0x669) || (c >= 0xFF10 && c <= 0xFF19); }
static int is_numeric(u32 c) { return is_digit(c) || c == 0xB2 || c == 0xB3 || c == 0xB9 || (c >= 0xBC && c <= 0xBE) || (c >= 0x2150 && c <= 0x218B); }

static int is_space(u32 c) {
  return (c >= 9 && c <= 13) || c == 32 || c == 0x85 || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
         c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
}

INTRINSIC(char__is_alphabetic) { UNUSED; return is_alpha((u32)A(0)); }
INTRINSIC(char__is_numeric) { UNUSED; return is_numeric((u32)A(0)); }
INTRINSIC(char__is_alphanumeric) { UNUSED; return is_alpha((u32)A(0)) || is_numeric((u32)A(0)); }
INTRINSIC(char__is_whitespace) { UNUSED; return is_space((u32)A(0)); }
INTRINSIC(char__is_uppercase) { UNUSED; return is_upper((u32)A(0)); }
INTRINSIC(char__is_lowercase) { UNUSED; return is_lower((u32)A(0)); }
INTRINSIC(char__is_ascii_digit) { UNUSED; return A(0) >= '0' && A(0) <= '9'; }
INTRINSIC(char__is_ascii_punctuation) {
  UNUSED;
  V c = A(0);
  return (c >= '!' && c <= '/') || (c >= ':' && c <= '@') || (c >= '[' && c <= '`') || (c >= '{' && c <= '~');
}
INTRINSIC(char__to_ascii_uppercase) { UNUSED; V c = A(0); return c >= 'a' && c <= 'z' ? c - 32 : c; }
INTRINSIC(char__to_ascii_lowercase) { UNUSED; V c = A(0); return c >= 'A' && c <= 'Z' ? c + 32 : c; }
INTRINSIC(char__to_digit) {
  UNUSED;
  V c = A(0), radix = A(1), d;
  if (c >= '0' && c <= '9') d = c - '0';
  else if ((c | 32) >= 'a' && (c | 32) <= 'z') d = (c | 32) - 'a' + 10;
  else return none();
  return d < radix ? some(d) : none();
}
INTRINSIC(char__len_utf8) { UNUSED; u8 b[4]; return utf8_encode((u32)A(0), b); }

/* ------------------------------------------------------------------------ */
/* Vec                                                                       */
/* ------------------------------------------------------------------------ */

static NORETURN void vec_panic(const char *what, V index, V len) {
  StringBuf *m = sb_new();
  sb_push_cstr(m, what);
  sb_push_cstr(m, " (is ");
  fmt_u64(m, index);
  sb_push_cstr(m, ") should be ");
  sb_push_cstr(m, what[0] == 'i' ? "<= len (is " : "< len (is ");
  fmt_u64(m, len);
  sb_push_cstr(m, ")");
  rt_panic_str(m->ptr, m->len);
}

INTRINSIC(Vec__new) { UNUSED; return (V)vec_new(4); }
INTRINSIC(Vec__push) { vec_push(SELF(Vec), A(1)); return 0; }
INTRINSIC(Vec__pop) { Vec *v = SELF(Vec); return v->len ? some(v->data[--v->len]) : none(); }
INTRINSIC(Vec__len) { return SELF(Vec)->len; }
INTRINSIC(Vec__clear) { SELF(Vec)->len = 0; return 0; }
INTRINSIC(Vec__insert) {
  Vec *v = SELF(Vec);
  u64 i = A(1);
  if (i > v->len) vec_panic("insertion index", i, v->len);
  vec_push(v, 0);
  memmove(v->data + i + 1, v->data + i, (v->len - 1 - i) * 8);
  v->data[i] = A(2);
  return 0;
}
INTRINSIC(Vec__remove) {
  Vec *v = SELF(Vec);
  u64 i = A(1);
  if (i >= v->len) vec_panic("removal index", i, v->len);
  V x = v->data[i];
  memmove(v->data + i, v->data + i + 1, (v->len - 1 - i) * 8);
  v->len--;
  return x;
}
INTRINSIC(Vec__swap) {
  Vec *v = SELF(Vec);
  u64 a = A(1), b = A(2);
  if (a >= v->len) rt_index_fail(v->len, a);
  if (b >= v->len) rt_index_fail(v->len, b);
  V t = v->data[a];
  v->data[a] = v->data[b];
  v->data[b] = t;
  return 0;
}
INTRINSIC(Vec__truncate) { Vec *v = SELF(Vec); if (A(1) < v->len) v->len = A(1); return 0; }
INTRINSIC(Vec__reverse) {
  Vec *v = SELF(Vec);
  for (u64 i = 0, j = v->len; i + 1 < j; i++, j--) { V t = v->data[i]; v->data[i] = v->data[j - 1]; v->data[j - 1] = t; }
  return 0;
}
INTRINSIC(vec__take_unchecked) { return SELF(Vec)->data[A(1)]; }
INTRINSIC(vec__from_elems) {
  Vec *v = vec_new((u64)argc);
  for (i64 i = 0; i < argc; i++) vec_push(v, A(i));
  return (V)v;
}
INTRINSIC(vec__from_elem) {
  V x = A(0), n = A(1), td = A(2);
  Vec *v = vec_new(n);
  for (u64 i = 0; i < n; i++) vec_push(v, i + 1 == n ? x : deep_clone(x, td));
  return (V)v;
}

INTRINSIC(Box__new) { UNUSED; V *cell = rt_alloc(8); *cell = A(0); return (V)cell; }

/* ------------------------------------------------------------------------ */
/* String and str                                                            */
/* ------------------------------------------------------------------------ */

INTRINSIC(String__new) { UNUSED; return (V)sb_new(); }
INTRINSIC(String__from) {
  const Str *s = (const Str *)A(0);
  StringBuf *b = sb_new();
  sb_push(b, s->ptr, s->len);
  return (V)b;
}
INTRINSIC(String__push_str) { const Str *s = (const Str *)A(1); sb_push(SELF(StringBuf), s->ptr, s->len); return 0; }
INTRINSIC(String__push) { sb_push_char(SELF(StringBuf), (u32)A(1)); return 0; }
INTRINSIC(String__as_str) { return (V)SELF(StringBuf); }
INTRINSIC(String__clear) { SELF(StringBuf)->len = 0; return 0; }
INTRINSIC(String__insert) {
  StringBuf *b = SELF(StringBuf);
  u64 i = A(1);
  check_boundary((const Str *)b, i, "byte index");
  u8 enc[4];
  u64 n = utf8_encode((u32)A(2), enc);
  sb_push(b, enc, n);
  memmove(b->ptr + i + n, b->ptr + i, b->len - n - i);
  memcpy(b->ptr + i, enc, n);
  return 0;
}
INTRINSIC(String__truncate) {
  StringBuf *b = SELF(StringBuf);
  if (A(1) < b->len) { check_boundary((const Str *)b, A(1), "new_len"); b->len = A(1); }
  return 0;
}
INTRINSIC(String__pop) {
  StringBuf *b = SELF(StringBuf);
  if (!b->len) return none();
  u64 i = b->len - 1;
  while (i > 0 && (b->ptr[i] & 0xC0) == 0x80) i--;
  u64 j = i;
  u32 c = utf8_next(b->ptr, b->len, &j);
  b->len = i;
  return some(c);
}
INTRINSIC(String__remove) {
  StringBuf *b = SELF(StringBuf);
  u64 i = A(1);
  check_boundary((const Str *)b, i, "byte index");
  if (i >= b->len) rt_panic_cstr("cannot remove a char from the end of a string");
  u64 j = i;
  u32 c = utf8_next(b->ptr, b->len, &j);
  memmove(b->ptr + i, b->ptr + j, b->len - j);
  b->len -= j - i;
  return c;
}

#define S(i) ((const Str *)A(i))

INTRINSIC(str__len) { return S(0)->len; }
INTRINSIC(str__char_count) {
  const Str *s = S(0);
  u64 n = 0;
  for (u64 i = 0; i < s->len; i++) if ((s->ptr[i] & 0xC0) != 0x80) n++;
  return n;
}

static V map_case(const Str *s, u32 (*f)(u32)) {
  StringBuf *b = sb_new();
  for (u64 i = 0; i < s->len;) sb_push_char(b, f(utf8_next(s->ptr, s->len, &i)));
  return (V)b;
}
INTRINSIC(str__to_uppercase) { return map_case(S(0), to_upper); }
INTRINSIC(str__to_lowercase) { return map_case(S(0), to_lower); }

static u64 skip_space_fwd(const Str *s, u64 i) {
  while (i < s->len) { u64 j = i; if (!is_space(utf8_next(s->ptr, s->len, &j))) break; i = j; }
  return i;
}
static u64 skip_space_back(const Str *s, u64 end) {
  while (end > 0) {
    u64 i = end - 1;
    while (i > 0 && (s->ptr[i] & 0xC0) == 0x80) i--;
    u64 j = i;
    if (!is_space(utf8_next(s->ptr, s->len, &j))) break;
    end = i;
  }
  return end;
}
INTRINSIC(str__trim) { const Str *s = S(0); u64 a = skip_space_fwd(s, 0), b = skip_space_back(s, s->len); return (V)str_view(s->ptr + a, b > a ? b - a : 0); }
INTRINSIC(str__trim_start) { const Str *s = S(0); u64 a = skip_space_fwd(s, 0); return (V)str_view(s->ptr + a, s->len - a); }
INTRINSIC(str__trim_end) { const Str *s = S(0); return (V)str_view(s->ptr, skip_space_back(s, s->len)); }

static i64 find(const Str *h, const Str *n, u64 from) {
  if (n->len == 0) return (i64)from;
  for (u64 i = from; i + n->len <= h->len; i++) if (memcmp(h->ptr + i, n->ptr, n->len) == 0) return (i64)i;
  return -1;
}
INTRINSIC(str__contains) { return find(S(0), S(1), 0) >= 0; }
INTRINSIC(str__starts_with) { const Str *a = S(0), *b = S(1); return b->len <= a->len && memcmp(a->ptr, b->ptr, b->len) == 0; }
INTRINSIC(str__ends_with) { const Str *a = S(0), *b = S(1); return b->len <= a->len && memcmp(a->ptr + a->len - b->len, b->ptr, b->len) == 0; }
INTRINSIC(str__find) { i64 i = find(S(0), S(1), 0); return i < 0 ? none() : some((V)i); }
INTRINSIC(str__replace) {
  const Str *s = S(0), *from = S(1), *to = S(2);
  StringBuf *b = sb_new();
  u64 i = 0;
  if (from->len == 0) { sb_push(b, s->ptr, s->len); return (V)b; }
  for (;;) {
    i64 j = find(s, from, i);
    if (j < 0) break;
    sb_push(b, s->ptr + i, (u64)j - i);
    sb_push(b, to->ptr, to->len);
    i = (u64)j + from->len;
  }
  sb_push(b, s->ptr + i, s->len - i);
  return (V)b;
}
INTRINSIC(str__repeat) {
  const Str *s = S(0);
  StringBuf *b = sb_new();
  for (u64 i = 0; i < A(1); i++) sb_push(b, s->ptr, s->len);
  return (V)b;
}
INTRINSIC(str__slice) {
  const Str *s = S(0);
  u64 a = A(1), e = A(2);
  if (a > e) {
    StringBuf *m = sb_new();
    sb_push_cstr(m, "begin <= end (");
    fmt_u64(m, a); sb_push_cstr(m, " <= "); fmt_u64(m, e);
    sb_push_cstr(m, ") when slicing `"); sb_push(m, s->ptr, s->len); sb_push_cstr(m, "`");
    rt_panic_str(m->ptr, m->len);
  }
  check_boundary(s, a, "byte index");
  check_boundary(s, e, "byte index");
  return (V)str_view(s->ptr + a, e - a);
}
INTRINSIC(str__split_whitespace_vec) {
  const Str *s = S(0);
  Vec *v = vec_new(4);
  u64 i = 0;
  for (;;) {
    i = skip_space_fwd(s, i);
    if (i >= s->len) break;
    u64 start = i;
    while (i < s->len) { u64 j = i; if (is_space(utf8_next(s->ptr, s->len, &j))) break; i = j; }
    vec_push(v, (V)str_view(s->ptr + start, i - start));
  }
  return (V)v;
}
INTRINSIC(str__split_vec) {
  const Str *s = S(0), *sep = S(1);
  Vec *v = vec_new(4);
  u64 i = 0;
  if (sep->len == 0) { vec_push(v, (V)s); return (V)v; }
  for (;;) {
    i64 j = find(s, sep, i);
    if (j < 0) break;
    vec_push(v, (V)str_view(s->ptr + i, (u64)j - i));
    i = (u64)j + sep->len;
  }
  vec_push(v, (V)str_view(s->ptr + i, s->len - i));
  return (V)v;
}
INTRINSIC(str__lines_vec) {
  const Str *s = S(0);
  Vec *v = vec_new(4);
  u64 start = 0;
  for (u64 i = 0; i < s->len; i++) {
    if (s->ptr[i] == '\n') {
      u64 end = i > start && s->ptr[i - 1] == '\r' ? i - 1 : i;
      vec_push(v, (V)str_view(s->ptr + start, end - start));
      start = i + 1;
    }
  }
  if (start < s->len) vec_push(v, (V)str_view(s->ptr + start, s->len - start));
  return (V)v;
}
INTRINSIC(str__next_char) {
  const Str *s = S(0);
  V *pos = (V *)A(1);
  if (*pos >= s->len) return none();
  u64 i = *pos;
  u32 c = utf8_next(s->ptr, s->len, &i);
  *pos = i;
  return some(c);
}

/* ------------------------------------------------------------------------ */
/* fmt, mem, process, cmp                                                    */
/* ------------------------------------------------------------------------ */

INTRINSIC(fmt__push_str) { const Str *s = (const Str *)A(1); sb_push(SELF(StringBuf), s->ptr, s->len); return 0; }
INTRINSIC(Formatter__alternate) { UNUSED; return 0; }
INTRINSIC(mem__replace) { V *dest = (V *)A(0); V old = *dest; *dest = A(1); return old; }
INTRINSIC(mem__swap) { V *a = (V *)A(0), *b = (V *)A(1); V t = *a; *a = *b; *b = t; return 0; }
INTRINSIC(process__exit) { rt_exit((i64)A(0)); }
INTRINSIC(cmp__to_ordering) { return agg_new((u32)((i64)A(0) + 1), 0); }
INTRINSIC(cmp__to_option_ordering) { i64 c = (i64)A(0); return c == 2 ? none() : some(agg_new((u32)(c + 1), 0)); }

/* ------------------------------------------------------------------------ */
/* Integers: one set of functions per type, generated with a macro.          */
/* ------------------------------------------------------------------------ */

static i64 imin(int bits) { return bits >= 64 ? (i64)0x8000000000000000ull : -((i64)1 << (bits - 1)); }
static i64 imax(int bits) { return bits >= 64 ? (i64)0x7fffffffffffffffull : ((i64)1 << (bits - 1)) - 1; }
static u64 umax(int bits) { return bits >= 64 ? ~(u64)0 : ((u64)1 << bits) - 1; }

static V wrap_s(V v, int bits) { if (bits >= 64) return v; u64 m = ((u64)1 << bits) - 1; v &= m; if (v >> (bits - 1)) v |= ~m; return v; }
static V wrap_u(V v, int bits) { return bits >= 64 ? v : v & (((u64)1 << bits) - 1); }

static int parse_digits(const Str *s, int allow_sign, int *neg, u64 *out, u64 limit) {
  u64 i = 0, v = 0;
  *neg = 0;
  if (i < s->len && (s->ptr[i] == '+' || (allow_sign && s->ptr[i] == '-'))) { *neg = s->ptr[i] == '-'; i++; }
  if (i == s->len) return 0;
  for (; i < s->len; i++) {
    u8 c = s->ptr[i];
    if (c < '0' || c > '9') return 0;
    if (v > (limit - (c - '0')) / 10) return 0;
    v = v * 10 + (c - '0');
  }
  *out = v;
  return 1;
}

#define SIGNED_INTRINSICS(T, BITS)                                                                              \
  INTRINSIC(T##__pow) {                                                                                         \
    UNUSED; i64 b = (i64)A(0), r = 1; u64 e = A(1);                                                            \
    while (e--) { if (__builtin_mul_overflow(r, b, &r) || r < imin(BITS) || r > imax(BITS)) rt_panic_kind(2); } \
    return (V)r;                                                                                                \
  }                                                                                                             \
  static V T##_checked(i64 r, int ovf) { return (ovf || r < imin(BITS) || r > imax(BITS)) ? none() : some((V)r); } \
  INTRINSIC(T##__checked_add) { UNUSED; i64 r; int o = __builtin_add_overflow((i64)A(0), (i64)A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_sub) { UNUSED; i64 r; int o = __builtin_sub_overflow((i64)A(0), (i64)A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_mul) { UNUSED; i64 r; int o = __builtin_mul_overflow((i64)A(0), (i64)A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_div) {                                                                                 \
    UNUSED; i64 a = (i64)A(0), b = (i64)A(1);                                                                   \
    if (b == 0 || (a == imin(BITS) && b == -1)) return none();                                                   \
    return some((V)(a / b));                                                                                    \
  }                                                                                                             \
  INTRINSIC(T##__wrapping_add) { UNUSED; return wrap_s(A(0) + A(1), BITS); }                                    \
  INTRINSIC(T##__wrapping_sub) { UNUSED; return wrap_s(A(0) - A(1), BITS); }                                    \
  INTRINSIC(T##__wrapping_mul) { UNUSED; return wrap_s(A(0) * A(1), BITS); }                                    \
  INTRINSIC(T##__saturating_add) {                                                                              \
    UNUSED; i64 r; if (__builtin_add_overflow((i64)A(0), (i64)A(1), &r)) r = (i64)A(1) > 0 ? imax(64) : imin(64); \
    return (V)(r > imax(BITS) ? imax(BITS) : r < imin(BITS) ? imin(BITS) : r);                                  \
  }                                                                                                             \
  INTRINSIC(T##__saturating_sub) {                                                                              \
    UNUSED; i64 r; if (__builtin_sub_overflow((i64)A(0), (i64)A(1), &r)) r = (i64)A(1) < 0 ? imax(64) : imin(64); \
    return (V)(r > imax(BITS) ? imax(BITS) : r < imin(BITS) ? imin(BITS) : r);                                  \
  }                                                                                                             \
  INTRINSIC(T##__rem_euclid) {                                                                                  \
    UNUSED; i64 a = (i64)A(0), b = (i64)A(1);                                                                   \
    if (b == 0) rt_panic_kind(9);                                                                               \
    i64 r = (a == imin(64) && b == -1) ? 0 : a % b;                                                             \
    return (V)(r < 0 ? (b < 0 ? r - b : r + b) : r);                                                            \
  }                                                                                                             \
  INTRINSIC(T##__abs) { UNUSED; i64 a = (i64)A(0); if (a == imin(BITS)) rt_panic_kind(5); return (V)(a < 0 ? -a : a); } \
  INTRINSIC(T##__signum) { UNUSED; i64 a = (i64)A(0); return (V)(i64)(a > 0 ? 1 : a < 0 ? -1 : 0); }           \
  INTRINSIC(num__parse_##T) {                                                                                   \
    UNUSED; int neg; u64 v;                                                                                     \
    if (!parse_digits((const Str *)A(0), 1, &neg, &v, (u64)imax(BITS) + 1)) return none();                      \
    if (!neg && v > (u64)imax(BITS)) return none();                                                             \
    return some(neg ? (V)(0 - v) : v);                                                                          \
  }

#define UNSIGNED_INTRINSICS(T, BITS)                                                                            \
  INTRINSIC(T##__pow) {                                                                                         \
    UNUSED; u64 b = A(0), r = 1, e = A(1);                                                                      \
    while (e--) { if (__builtin_mul_overflow(r, b, &r) || r > umax(BITS)) rt_panic_kind(2); }                   \
    return r;                                                                                                   \
  }                                                                                                             \
  static V T##_checked(u64 r, int ovf) { return (ovf || r > umax(BITS)) ? none() : some(r); }                   \
  INTRINSIC(T##__checked_add) { UNUSED; u64 r; int o = __builtin_add_overflow(A(0), A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_sub) { UNUSED; u64 r; int o = __builtin_sub_overflow(A(0), A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_mul) { UNUSED; u64 r; int o = __builtin_mul_overflow(A(0), A(1), &r); return T##_checked(r, o); } \
  INTRINSIC(T##__checked_div) { UNUSED; return A(1) == 0 ? none() : some(A(0) / A(1)); }                       \
  INTRINSIC(T##__wrapping_add) { UNUSED; return wrap_u(A(0) + A(1), BITS); }                                    \
  INTRINSIC(T##__wrapping_sub) { UNUSED; return wrap_u(A(0) - A(1), BITS); }                                    \
  INTRINSIC(T##__wrapping_mul) { UNUSED; return wrap_u(A(0) * A(1), BITS); }                                    \
  INTRINSIC(T##__saturating_add) { UNUSED; u64 r; if (__builtin_add_overflow(A(0), A(1), &r) || r > umax(BITS)) r = umax(BITS); return r; } \
  INTRINSIC(T##__saturating_sub) { UNUSED; return A(0) > A(1) ? A(0) - A(1) : 0; }                             \
  INTRINSIC(T##__rem_euclid) { UNUSED; if (A(1) == 0) rt_panic_kind(9); return A(0) % A(1); }                  \
  INTRINSIC(T##__is_power_of_two) { UNUSED; return A(0) && !(A(0) & (A(0) - 1)); }                             \
  INTRINSIC(num__parse_##T) {                                                                                   \
    UNUSED; int neg; u64 v;                                                                                     \
    if (!parse_digits((const Str *)A(0), 0, &neg, &v, umax(BITS))) return none();                               \
    return some(v);                                                                                             \
  }

SIGNED_INTRINSICS(i8, 8)
SIGNED_INTRINSICS(i16, 16)
SIGNED_INTRINSICS(i32, 32)
SIGNED_INTRINSICS(i64, 64)
SIGNED_INTRINSICS(isize, 64)
UNSIGNED_INTRINSICS(u8, 8)
UNSIGNED_INTRINSICS(u16, 16)
UNSIGNED_INTRINSICS(u32, 32)
UNSIGNED_INTRINSICS(u64, 64)
UNSIGNED_INTRINSICS(usize, 64)

/* ------------------------------------------------------------------------ */
/* Floats. Transcendental functions use the x87 FPU's built-in instructions. */
/* ------------------------------------------------------------------------ */

static double x87_sin(double x) { long double r = x; __asm__("fsin" : "+t"(r)); return (double)r; }
static double x87_cos(double x) { long double r = x; __asm__("fcos" : "+t"(r)); return (double)r; }
static double x87_atan2(double y, double x) {
  long double r;
  __asm__("fpatan" : "=t"(r) : "0"((long double)x), "u"((long double)y) : "st(1)");
  return (double)r;
}
static double x87_log2(double x) {
  long double r;
  __asm__("fld1; fxch; fyl2x" : "=t"(r) : "0"((long double)x));
  return (double)r;
}
static double x87_exp2(double x) {
  /* 2^x = 2^int(x) * 2^frac(x), with f2xm1 computing 2^frac - 1 */
  long double r;
  __asm__(
      "fld %%st(0)\n\t"
      "frndint\n\t"
      "fsub %%st, %%st(1)\n\t"
      "fxch\n\t"
      "f2xm1\n\t"
      "fld1\n\t"
      "faddp\n\t"
      "fscale\n\t"
      "fstp %%st(1)"
      : "=t"(r)
      : "0"((long double)x));
  return (double)r;
}
static double fsqrt(double x) { double r; __asm__("sqrtsd %1, %0" : "=x"(r) : "x"(x)); return r; }
static double ffloor(double x) { double r; __asm__("roundsd $9, %1, %0" : "=x"(r) : "x"(x)); return r; }
static double fceil(double x) { double r; __asm__("roundsd $10, %1, %0" : "=x"(r) : "x"(x)); return r; }
static double ftrunc(double x) { double r; __asm__("roundsd $11, %1, %0" : "=x"(r) : "x"(x)); return r; }
static double fround(double x) { double t = ftrunc(x); double d = x - t; if (d >= 0.5) t += 1; else if (d <= -0.5) t -= 1; return t; }
static double fexp(double x) { return x87_exp2(x * 1.4426950408889634); }
static double fln(double x) { return x87_log2(x) * 0.6931471805599453; }
static double fpow(double b, double e) {
  if (e == 0) return 1;
  if (b == 0) return e > 0 ? 0.0 : 1.0 / 0.0;
  if (e == ftrunc(e) && e > -1e9 && e < 1e9) {
    i64 n = (i64)e;
    int neg = n < 0;
    if (neg) n = -n;
    double r = 1, p = b;
    while (n) { if (n & 1) r *= p; p *= p; n >>= 1; }
    return neg ? 1 / r : r;
  }
  if (b < 0) return 0.0 / 0.0;
  return x87_exp2(e * x87_log2(b));
}

#define F(i) as_f64(A(i))
#define FLOAT_INTRINSICS(T, CONV)                                                                              \
  INTRINSIC(T##__sqrt) { UNUSED; return from_f64(CONV(fsqrt(F(0)))); }                                          \
  INTRINSIC(T##__abs) { UNUSED; return A(0) & 0x7fffffffffffffffull; }                                          \
  INTRINSIC(T##__powi) { UNUSED; return from_f64(CONV(fpow(F(0), (double)(i64)A(1)))); }                         \
  INTRINSIC(T##__powf) { UNUSED; return from_f64(CONV(fpow(F(0), F(1)))); }                                     \
  INTRINSIC(T##__floor) { UNUSED; return from_f64(ffloor(F(0))); }                                              \
  INTRINSIC(T##__ceil) { UNUSED; return from_f64(fceil(F(0))); }                                                \
  INTRINSIC(T##__round) { UNUSED; return from_f64(fround(F(0))); }                                              \
  INTRINSIC(T##__trunc) { UNUSED; return from_f64(ftrunc(F(0))); }                                              \
  INTRINSIC(T##__sin) { UNUSED; return from_f64(CONV(x87_sin(F(0)))); }                                         \
  INTRINSIC(T##__cos) { UNUSED; return from_f64(CONV(x87_cos(F(0)))); }                                         \
  INTRINSIC(T##__tan) { UNUSED; return from_f64(CONV(x87_sin(F(0)) / x87_cos(F(0)))); }                         \
  INTRINSIC(T##__atan2) { UNUSED; return from_f64(CONV(x87_atan2(F(0), F(1)))); }                               \
  INTRINSIC(T##__exp) { UNUSED; return from_f64(CONV(fexp(F(0)))); }                                            \
  INTRINSIC(T##__ln) { UNUSED; return from_f64(CONV(fln(F(0)))); }                                              \
  INTRINSIC(T##__log10) { UNUSED; return from_f64(CONV(x87_log2(F(0)) * 0.30102999566398120)); }               \
  INTRINSIC(T##__min) { UNUSED; double a = F(0), b = F(1); return from_f64(a != a ? b : b != b ? a : a < b ? a : b); } \
  INTRINSIC(T##__max) { UNUSED; double a = F(0), b = F(1); return from_f64(a != a ? b : b != b ? a : a > b ? a : b); } \
  INTRINSIC(T##__is_nan) { UNUSED; return F(0) != F(0); }                                                       \
  INTRINSIC(T##__signum) { UNUSED; double a = F(0); return from_f64(a != a ? a : (A(0) >> 63) ? -1.0 : 1.0); }  \
  INTRINSIC(T##__to_degrees) { UNUSED; return from_f64(CONV(F(0) * 57.29577951308232)); }                       \
  INTRINSIC(T##__to_radians) { UNUSED; return from_f64(CONV(F(0) * 0.017453292519943295)); }                    \
  INTRINSIC(num__parse_##T) {                                                                                   \
    UNUSED; const Str *s = (const Str *)A(0); double d;                                                         \
    return parse_f64(s->ptr, s->len, &d) ? some(from_f64(CONV(d))) : none();                                   \
  }

static double to_f32(double d) { return (double)(float)d; }
static double to_f64(double d) { return d; }
FLOAT_INTRINSICS(f32, to_f32)
FLOAT_INTRINSICS(f64, to_f64)

/* ------------------------------------------------------------------------ */
/* HashMap. Every map intrinsic gets the key's type descriptor as its last   */
/* argument, for hashing and equality.                                       */
/* ------------------------------------------------------------------------ */

#define KEY_TD A(argc - 1)

static void map_grow_table(Map *m, V td) {
  u64 cap = m->tcap ? m->tcap * 2 : 16;
  u64 *t = rt_alloc(cap * 8);
  memset(t, 0, cap * 8);
  for (u64 i = 0; i < m->slots; i++) {
    if (!m->alive[i]) continue;
    u64 h = hash_value(m->keys[i], td) & (cap - 1);
    while (t[h]) h = (h + 1) & (cap - 1);
    t[h] = i + 1;
  }
  m->table = t;
  m->tcap = cap;
}

/* Find the table position for `key`: returns the slot index, or -1 with *pos at an empty spot. */
static i64 map_find(const Map *m, V key, V td, u64 *pos) {
  if (!m->tcap) return -1;
  u64 h = hash_value(key, td) & (m->tcap - 1);
  while (m->table[h]) {
    u64 slot = m->table[h] - 1;
    if (m->alive[slot] && deep_eq(m->keys[slot], key, td)) { if (pos) *pos = h; return (i64)slot; }
    h = (h + 1) & (m->tcap - 1);
  }
  if (pos) *pos = h;
  return -1;
}

static u64 map_add(Map *m, V key, V val, V td) {
  if ((m->slots + 1) * 2 > m->tcap) map_grow_table(m, td);
  if (m->slots == m->cap) {
    u64 cap = m->cap ? m->cap * 2 : 8;
    V *k = rt_alloc(cap * 8), *v = rt_alloc(cap * 8);
    u8 *a = rt_alloc(cap);
    memcpy(k, m->keys, m->slots * 8);
    memcpy(v, m->vals, m->slots * 8);
    memcpy(a, m->alive, m->slots);
    m->keys = k; m->vals = v; m->alive = a; m->cap = cap;
  }
  u64 slot = m->slots++;
  m->keys[slot] = key;
  m->vals[slot] = val;
  m->alive[slot] = 1;
  m->size++;
  u64 h = hash_value(key, td) & (m->tcap - 1);
  while (m->table[h]) h = (h + 1) & (m->tcap - 1);
  m->table[h] = slot + 1;
  return slot;
}

INTRINSIC(HashMap__new) {
  UNUSED;
  Map *m = rt_alloc(sizeof *m);
  memset(m, 0, sizeof *m);
  return (V)m;
}
INTRINSIC(HashMap__insert) {
  Map *m = SELF(Map);
  i64 slot = map_find(m, A(1), KEY_TD, 0);
  if (slot >= 0) { V old = m->vals[slot]; m->vals[slot] = A(2); return some(old); }
  map_add(m, A(1), A(2), KEY_TD);
  return none();
}
INTRINSIC(HashMap__get) {
  Map *m = SELF(Map);
  i64 slot = map_find(m, *(V *)A(1), KEY_TD, 0);
  return slot < 0 ? none() : some((V)&m->vals[slot]);
}
INTRINSIC(HashMap__get_mut) { return rt_i_HashMap__get(sp, argc); }
INTRINSIC(HashMap__contains_key) { return map_find(SELF(Map), *(V *)A(1), KEY_TD, 0) >= 0; }
INTRINSIC(HashMap__remove) {
  Map *m = SELF(Map);
  i64 slot = map_find(m, *(V *)A(1), KEY_TD, 0);
  if (slot < 0) return none();
  m->alive[slot] = 0;
  m->size--;
  return some(m->vals[slot]);
}
INTRINSIC(HashMap__len) { return SELF(Map)->size; }
INTRINSIC(HashMap__clear) { Map *m = SELF(Map); m->slots = 0; m->size = 0; m->tcap = 0; return 0; }
INTRINSIC(HashMap__index_ref) {
  Map *m = (Map *)A(0);
  i64 slot = map_find(m, *(V *)A(1), KEY_TD, 0);
  if (slot < 0) rt_panic_cstr("key not found in HashMap");
  return (V)&m->vals[slot];
}
INTRINSIC(collections__slot_count) { return SELF(Map)->slots; }
INTRINSIC(collections__slot) {
  Map *m = SELF(Map);
  u64 i = A(1);
  if (!m->alive[i]) return none();
  V pair = agg_new(0, 2);
  ((Agg *)pair)->f[0] = (V)&m->keys[i];
  ((Agg *)pair)->f[1] = (V)&m->vals[i];
  return some(pair);
}
INTRINSIC(collections__entry_ref) {
  Map *m = SELF(Map);
  i64 slot = map_find(m, A(1), KEY_TD, 0);
  if (slot < 0) slot = (i64)map_add(m, A(1), A(2), KEY_TD);
  return (V)&m->vals[slot];
}
