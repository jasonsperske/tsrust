/*
 * TSRust native runtime: formatting values like Rust's `{}` and `{:?}`.
 *
 * The interesting part is floats. Rust prints the *shortest* decimal string
 * that reads back as the same float (0.1 + 0.2 prints 0.30000000000000004,
 * not 0.3). We find those digits with the classic Steele & White / Dragon4
 * algorithm on exact big integers: the float is f * 2^e exactly, and we
 * generate decimal digits until the remaining digits can no longer change
 * which float the number denotes.
 */
#include "runtime.h"

/* ------------------------------------------------------------------------ */
/* Integers                                                                  */
/* ------------------------------------------------------------------------ */

void fmt_u64(StringBuf *out, u64 v) {
  u8 buf[24];
  int i = 24;
  do { buf[--i] = (u8)('0' + v % 10); v /= 10; } while (v);
  sb_push(out, buf + i, 24 - i);
}

void fmt_i64(StringBuf *out, i64 v) {
  if (v < 0) { sb_push(out, (const u8 *)"-", 1); fmt_u64(out, (u64)0 - (u64)v); }
  else fmt_u64(out, (u64)v);
}

/* ------------------------------------------------------------------------ */
/* Big integers, just enough for exact float conversion                      */
/* ------------------------------------------------------------------------ */

#define BIG_WORDS 90
typedef struct { int n; u32 w[BIG_WORDS]; } Big; /* little-endian 32-bit limbs */

static void big_set(Big *b, u64 v) {
  b->n = 0;
  while (v) { b->w[b->n++] = (u32)v; v >>= 32; }
}

static void big_mul_small(Big *b, u32 m) {
  u64 carry = 0;
  for (int i = 0; i < b->n; i++) {
    u64 t = (u64)b->w[i] * m + carry;
    b->w[i] = (u32)t;
    carry = t >> 32;
  }
  if (carry) b->w[b->n++] = (u32)carry;
}

static void big_shl(Big *b, int bits) {
  int words = bits / 32, rem = bits % 32;
  if (b->n == 0) return;
  for (int i = b->n - 1; i >= 0; i--) b->w[i + words] = b->w[i];
  for (int i = 0; i < words; i++) b->w[i] = 0;
  b->n += words;
  if (rem) {
    u32 carry = 0;
    for (int i = words; i < b->n; i++) {
      u32 nc = b->w[i] >> (32 - rem);
      b->w[i] = (b->w[i] << rem) | carry;
      carry = nc;
    }
    if (carry) b->w[b->n++] = carry;
  }
}

static void big_mul_pow10(Big *b, int k) {
  while (k >= 9) { big_mul_small(b, 1000000000u); k -= 9; }
  static const u32 p10[9] = {1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000};
  if (k > 0) big_mul_small(b, p10[k]);
}

static int big_cmp(const Big *a, const Big *b) {
  if (a->n != b->n) return a->n < b->n ? -1 : 1;
  for (int i = a->n - 1; i >= 0; i--) if (a->w[i] != b->w[i]) return a->w[i] < b->w[i] ? -1 : 1;
  return 0;
}

static void big_add(Big *r, const Big *a, const Big *b) {
  u64 carry = 0;
  int n = a->n > b->n ? a->n : b->n;
  for (int i = 0; i < n; i++) {
    u64 t = carry + (i < a->n ? a->w[i] : 0) + (i < b->n ? b->w[i] : 0);
    r->w[i] = (u32)t;
    carry = t >> 32;
  }
  r->n = n;
  if (carry) r->w[r->n++] = (u32)carry;
}

static void big_sub(Big *a, const Big *b) { /* a -= b, requires a >= b */
  i64 borrow = 0;
  for (int i = 0; i < a->n; i++) {
    i64 t = (i64)a->w[i] - (i < b->n ? b->w[i] : 0) - borrow;
    borrow = t < 0;
    a->w[i] = (u32)t;
  }
  while (a->n && a->w[a->n - 1] == 0) a->n--;
}

/* floor(a / b) where the result is known to be < 10; a becomes the remainder. */
static int big_divmod_small(Big *a, const Big *b) {
  int d = 0;
  while (big_cmp(a, b) >= 0) { big_sub(a, b); d++; }
  return d;
}

static void big_copy(Big *d, const Big *s) {
  d->n = s->n;
  for (int i = 0; i < s->n; i++) d->w[i] = s->w[i];
}

/* Decompose a finite, nonzero, positive float into f * 2^e. `bits` is 32 or 64. */
static void decompose(double d, int bits, u64 *f, int *e, int *min_e, u64 *hidden) {
  if (bits == 32) {
    union { float f; u32 u; } x;
    x.f = (float)d;
    u32 mant = x.u & 0x7fffff, exp = (x.u >> 23) & 0xff;
    *hidden = 1u << 23;
    *min_e = -149;
    if (exp == 0) { *f = mant; *e = -149; }
    else { *f = mant | (1u << 23); *e = (int)exp - 150; }
  } else {
    union { double d; u64 u; } x;
    x.d = d;
    u64 mant = x.u & 0xfffffffffffffull, exp = (x.u >> 52) & 0x7ff;
    *hidden = (u64)1 << 52;
    *min_e = -1074;
    if (exp == 0) { *f = mant; *e = -1074; }
    else { *f = mant | ((u64)1 << 52); *e = (int)exp - 1075; }
  }
}

/*
 * Shortest digits: writes digits to `out` and returns their count; *k_out is
 * the decimal exponent such that value = 0.DIGITS * 10^k.
 */
static int shortest_digits(double d, int bits, u8 *out, int *k_out) {
  u64 f, hidden;
  int e, min_e;
  decompose(d, bits, &f, &e, &min_e, &hidden);
  int even = (f & 1) == 0;
  Big r, s, mp, mm;
  if (e >= 0) {
    if (f != hidden) {
      big_set(&r, f); big_shl(&r, e + 1);
      big_set(&s, 2);
      big_set(&mp, 1); big_shl(&mp, e);
      big_set(&mm, 1); big_shl(&mm, e);
    } else {
      big_set(&r, f); big_shl(&r, e + 2);
      big_set(&s, 4);
      big_set(&mp, 1); big_shl(&mp, e + 1);
      big_set(&mm, 1); big_shl(&mm, e);
    }
  } else {
    if (e == min_e || f != hidden) {
      big_set(&r, f); big_shl(&r, 1);
      big_set(&s, 1); big_shl(&s, 1 - e);
      big_set(&mp, 1);
      big_set(&mm, 1);
    } else {
      big_set(&r, f); big_shl(&r, 2);
      big_set(&s, 1); big_shl(&s, 2 - e);
      big_set(&mp, 2);
      big_set(&mm, 1);
    }
  }
  /* Estimate k = ceil(log10(value)), then scale so that 0.1 <= r/s < 1. */
  int bitlen = 64 - __builtin_clzll(f);
  double est = (double)(e + bitlen - 1) * 0.30102999566398114;
  int k = (int)est;
  if (est > 0 && (double)k != est) k++;
  if (k >= 0) big_mul_pow10(&s, k);
  else { big_mul_pow10(&r, -k); big_mul_pow10(&mp, -k); big_mul_pow10(&mm, -k); }
  Big t;
  big_add(&t, &r, &mp);
  int c = big_cmp(&t, &s);
  if (c > 0 || (c == 0 && even)) k++;
  else { big_mul_small(&r, 10); big_mul_small(&mp, 10); big_mul_small(&mm, 10); }
  /* The estimate can be one too high: then r/s < 0.1. */
  int n = 0;
  for (;;) {
    int dgt = big_divmod_small(&r, &s);
    int lc = big_cmp(&r, &mm);
    int low = lc < 0 || (lc == 0 && even);
    big_add(&t, &r, &mp);
    int hc = big_cmp(&t, &s);
    int high = hc > 0 || (hc == 0 && even);
    if (!low && !high) {
      out[n++] = (u8)('0' + dgt);
      big_mul_small(&r, 10); big_mul_small(&mp, 10); big_mul_small(&mm, 10);
      continue;
    }
    if (low && high) {
      Big r2;
      big_copy(&r2, &r);
      big_shl(&r2, 1);
      int c2 = big_cmp(&r2, &s);
      if (c2 > 0 || (c2 == 0 && (dgt & 1))) dgt++;
    } else if (high) {
      dgt++;
    }
    out[n++] = (u8)('0' + dgt);
    break;
  }
  /* A final digit of 10 carries into the previous digits. */
  for (int i = n - 1; i > 0 && out[i] > '9'; i--) { out[i] = '0'; out[i - 1]++; }
  if (out[0] > '9') { out[0] = '1'; for (int i = 1; i < n; i++) out[i] = '0'; k++; }
  while (n > 1 && out[n - 1] == '0') n--;
  /* Normalize a leading zero produced by an overestimated k. */
  if (out[0] == '0' && n > 1) { for (int i = 1; i < n; i++) out[i - 1] = out[i]; n--; k--; }
  *k_out = k;
  return n;
}

/* Exactly round value * 10^prec to an integer (ties to even); returns its decimal digits. */
static int fixed_digits(double d, int bits, int prec, u8 *out, int max) {
  u64 f, hidden;
  int e, min_e;
  decompose(d, bits, &f, &e, &min_e, &hidden);
  Big r, s, S;
  big_set(&r, f);
  big_set(&s, 1);
  if (e >= 0) big_shl(&r, e);
  else big_shl(&s, -e);
  big_mul_pow10(&r, prec);
  /* Number of integer digits of r/s. */
  int k = 0;
  big_copy(&S, &s);
  while (big_cmp(&S, &r) <= 0 && k < max - 2) { big_mul_small(&S, 10); k++; }
  int n = 0;
  for (int i = 0; i < k; i++) {
    big_mul_small(&r, 10);
    out[n++] = (u8)('0' + big_divmod_small(&r, &S));
  }
  /* Round half to even on the remainder. */
  big_shl(&r, 1);
  int c = big_cmp(&r, &S);
  int up = c > 0 || (c == 0 && n > 0 && ((out[n - 1] - '0') & 1));
  if (up) {
    int i = n - 1;
    while (i >= 0 && out[i] == '9') out[i--] = '0';
    if (i >= 0) out[i]++;
    else { for (int j = n; j > 0; j--) out[j] = out[j - 1]; out[0] = '1'; n++; }
  }
  if (n == 0) out[n++] = '0';
  return n;
}

static void push_zeros(StringBuf *o, int n) {
  while (n-- > 0) sb_push(o, (const u8 *)"0", 1);
}

static void fmt_float_bits(StringBuf *out, double d, int bits, int debug, i64 prec) {
  if (d != d) { sb_push_cstr(out, "NaN"); return; }
  union { double d; u64 u; } x;
  x.d = d;
  int neg = (x.u >> 63) != 0;
  if (d == 1.0 / 0.0 || d == -1.0 / 0.0) { sb_push_cstr(out, neg ? "-inf" : "inf"); return; }
  if (neg) { sb_push(out, (const u8 *)"-", 1); d = -d; }
  u8 digits[1200];
  if (prec >= 0) {
    if (d == 0) { sb_push(out, (const u8 *)"0", 1); if (prec) { sb_push(out, (const u8 *)".", 1); push_zeros(out, (int)prec); } return; }
    int n = fixed_digits(d, bits, (int)prec, digits, (int)sizeof digits);
    int p = (int)prec;
    if (n <= p) { sb_push(out, (const u8 *)"0.", p ? 2 : 1); push_zeros(out, p - n); sb_push(out, digits, n); return; }
    sb_push(out, digits, n - p);
    if (p) { sb_push(out, (const u8 *)".", 1); sb_push(out, digits + n - p, p); }
    return;
  }
  if (d == 0) { sb_push_cstr(out, debug ? "0.0" : "0"); return; }
  int k;
  int n = shortest_digits(d, bits, digits, &k);
  /* Debug switches to scientific notation outside [1e-4, 1e16). */
  if (debug && (k < -3 || k > 16)) {
    sb_push(out, digits, 1);
    if (n > 1) { sb_push(out, (const u8 *)".", 1); sb_push(out, digits + 1, n - 1); }
    sb_push(out, (const u8 *)"e", 1);
    fmt_i64(out, k - 1);
    return;
  }
  if (k <= 0) {
    sb_push(out, (const u8 *)"0.", 2);
    push_zeros(out, -k);
    sb_push(out, digits, n);
  } else if (k < n) {
    sb_push(out, digits, k);
    sb_push(out, (const u8 *)".", 1);
    sb_push(out, digits + k, n - k);
  } else {
    sb_push(out, digits, n);
    push_zeros(out, k - n);
    if (debug) sb_push(out, (const u8 *)".0", 2);
  }
}

void fmt_f64(StringBuf *out, double d, int debug, i64 prec) { fmt_float_bits(out, d, 64, debug, prec); }

/* ------------------------------------------------------------------------ */
/* Parsing floats (for str::parse::<f64>)                                    */
/* ------------------------------------------------------------------------ */

static int eq_nocase(const u8 *p, u64 n, const char *w) {
  u64 i = 0;
  for (; w[i]; i++) {
    if (i >= n) return 0;
    u8 c = p[i];
    if (c >= 'A' && c <= 'Z') c += 32;
    if (c != (u8)w[i]) return 0;
  }
  return i == n;
}

int parse_f64(const u8 *p, u64 n, double *out) {
  int neg = 0;
  u64 i = 0;
  if (i < n && (p[i] == '+' || p[i] == '-')) { neg = p[i] == '-'; i++; }
  if (eq_nocase(p + i, n - i, "inf") || eq_nocase(p + i, n - i, "infinity")) { *out = neg ? -1.0 / 0.0 : 1.0 / 0.0; return 1; }
  if (eq_nocase(p + i, n - i, "nan")) { *out = 0.0 / 0.0; return 1; }
  u64 mant = 0;
  int digits = 0, exp10 = 0, any = 0;
  for (; i < n && p[i] >= '0' && p[i] <= '9'; i++) {
    any = 1;
    if (digits < 19) { mant = mant * 10 + (p[i] - '0'); if (mant) digits++; } else exp10++;
  }
  if (i < n && p[i] == '.') {
    i++;
    for (; i < n && p[i] >= '0' && p[i] <= '9'; i++) {
      any = 1;
      if (digits < 19) { mant = mant * 10 + (p[i] - '0'); if (mant) digits++; exp10--; }
    }
  }
  if (!any) return 0;
  if (i < n && (p[i] == 'e' || p[i] == 'E')) {
    i++;
    int eneg = 0, ev = 0, eany = 0;
    if (i < n && (p[i] == '+' || p[i] == '-')) { eneg = p[i] == '-'; i++; }
    for (; i < n && p[i] >= '0' && p[i] <= '9'; i++) { eany = 1; if (ev < 100000) ev = ev * 10 + (p[i] - '0'); }
    if (!eany) return 0;
    exp10 += eneg ? -ev : ev;
  }
  if (i != n) return 0;
  /* Scale with 80-bit extended precision: correctly rounded for typical inputs. */
  long double v = (long double)mant, base = 10.0L;
  int ex = exp10 < 0 ? -exp10 : exp10;
  long double scale = 1.0L;
  while (ex) { if (ex & 1) scale *= base; base *= base; ex >>= 1; }
  v = exp10 < 0 ? v / scale : v * scale;
  *out = neg ? -(double)v : (double)v;
  return 1;
}

/* ------------------------------------------------------------------------ */
/* Values, guided by type descriptors                                        */
/* ------------------------------------------------------------------------ */

static void push_escaped(StringBuf *out, const u8 *p, u64 n, u8 quote) {
  for (u64 i = 0; i < n; i++) {
    u8 c = p[i];
    switch (c) {
      case '\n': sb_push_cstr(out, "\\n"); break;
      case '\t': sb_push_cstr(out, "\\t"); break;
      case '\r': sb_push_cstr(out, "\\r"); break;
      case '\\': sb_push_cstr(out, "\\\\"); break;
      case 0: sb_push_cstr(out, "\\0"); break;
      default:
        if (c == quote) { sb_push(out, (const u8 *)"\\", 1); sb_push(out, &c, 1); }
        else sb_push(out, &c, 1);
    }
  }
}

static void push_name(StringBuf *out, u32 name) {
  Str s = rt_name(name);
  sb_push(out, s.ptr, s.len);
}

static void indent_to(StringBuf *out, int indent) {
  for (int i = 0; i < indent; i++) sb_push(out, (const u8 *)"    ", 4);
}

static void fmt_int(StringBuf *out, V v, u32 kind) {
  if (kind <= K_ISIZE) fmt_i64(out, (i64)v);
  else fmt_u64(out, v);
}

/* `name { a: .., b: .. }`, `name(.., ..)` or `name`: shared by structs and enum variants. */
static void fmt_fields(StringBuf *out, const u32 *t, const V *values, int pretty, i64 prec, int indent) {
  /* t points at: name, kind (0 named / 1 tuple / 2 unit), nfields, (fieldname, ty)* */
  u32 name = t[0], kind = t[1], n = t[2];
  push_name(out, name);
  if (kind == 2) return;
  if (n == 0) { if (kind == 0) sb_push_cstr(out, " {}"); else sb_push_cstr(out, "()"); return; }
  sb_push_cstr(out, kind == 0 ? (pretty ? " {\n" : " { ") : (pretty ? "(\n" : "("));
  for (u32 i = 0; i < n; i++) {
    if (pretty) indent_to(out, indent + 1);
    if (kind == 0) { push_name(out, t[3 + 2 * i]); sb_push_cstr(out, ": "); }
    fmt_value(out, values[i], t[4 + 2 * i], 1, pretty, prec, indent + 1);
    if (pretty) sb_push_cstr(out, ",\n");
    else if (i + 1 < n) sb_push_cstr(out, ", ");
  }
  if (pretty) indent_to(out, indent);
  sb_push_cstr(out, kind == 0 ? (pretty ? "}" : " }") : ")");
}

/* Is a reference to this type represented by the value itself (i.e. `&str`)? */
static int ref_is_value(V td) { return rt_type(td)[0] == T_STR; }

static void fmt_list(StringBuf *out, const char *open, const char *close, const V *items, u64 n, V elem, int pretty, i64 prec, int indent) {
  sb_push_cstr(out, open);
  if (n == 0) { sb_push_cstr(out, close); return; }
  if (pretty) sb_push_cstr(out, "\n");
  for (u64 i = 0; i < n; i++) {
    if (pretty) indent_to(out, indent + 1);
    fmt_value(out, items[i], elem, 1, pretty, prec, indent + 1);
    if (pretty) sb_push_cstr(out, ",\n");
    else if (i + 1 < n) sb_push_cstr(out, ", ");
  }
  if (pretty) indent_to(out, indent);
  sb_push_cstr(out, close);
}

void fmt_value(StringBuf *out, V v, V td, int debug, int pretty, i64 prec, int indent) {
  const u32 *t = rt_type(td);
  switch (t[0]) {
    case T_INT: fmt_int(out, v, t[1]); return;
    case T_FLOAT: fmt_float_bits(out, t[1] == 32 ? (double)(float)as_f64(v) : as_f64(v), t[1], debug, prec); return;
    case T_BOOL: sb_push_cstr(out, v ? "true" : "false"); return;
    case T_CHAR: {
      u8 b[4];
      u64 n = utf8_encode((u32)v, b);
      if (debug) { sb_push(out, (const u8 *)"'", 1); push_escaped(out, b, n, '\''); sb_push(out, (const u8 *)"'", 1); }
      else sb_push(out, b, n);
      return;
    }
    case T_STR: case T_STRING: {
      const Str *s = (const Str *)v;
      if (debug) { sb_push(out, (const u8 *)"\"", 1); push_escaped(out, s->ptr, s->len, '"'); sb_push(out, (const u8 *)"\"", 1); }
      else sb_push(out, s->ptr, s->len);
      return;
    }
    case T_UNIT: sb_push_cstr(out, "()"); return;
    case T_NEVER: sb_push_cstr(out, "!"); return;
    case T_REF: fmt_value(out, ref_is_value(t[1]) ? v : *(V *)v, t[1], debug, pretty, prec, indent); return;
    case T_BOX: fmt_value(out, *(V *)v, t[1], debug, pretty, prec, indent); return;
    case T_TUPLE: {
      const Agg *a = (const Agg *)v;
      if (t[1] == 1 && !pretty) {
        sb_push_cstr(out, "(");
        fmt_value(out, a->f[0], t[2], 1, 0, prec, indent);
        sb_push_cstr(out, ",)");
        return;
      }
      sb_push_cstr(out, "(");
      if (pretty) sb_push_cstr(out, "\n");
      for (u32 i = 0; i < t[1]; i++) {
        if (pretty) indent_to(out, indent + 1);
        fmt_value(out, a->f[i], t[2 + i], 1, pretty, prec, indent + 1);
        if (pretty) sb_push_cstr(out, ",\n");
        else if (i + 1 < t[1]) sb_push_cstr(out, ", ");
      }
      if (pretty) indent_to(out, indent);
      sb_push_cstr(out, ")");
      return;
    }
    case T_VEC: {
      const Vec *vec = (const Vec *)v;
      fmt_list(out, "[", "]", vec->data, vec->len, t[1], pretty, prec, indent);
      return;
    }
    case T_MAP: {
      const Map *m = (const Map *)v;
      sb_push_cstr(out, "{");
      int first = 1;
      if (pretty && m->size) sb_push_cstr(out, "\n");
      for (u64 i = 0; i < m->slots; i++) {
        if (!m->alive[i]) continue;
        if (pretty) indent_to(out, indent + 1);
        else if (!first) sb_push_cstr(out, ", ");
        fmt_value(out, m->keys[i], t[1], 1, pretty, prec, indent + 1);
        sb_push_cstr(out, ": ");
        fmt_value(out, m->vals[i], t[2], 1, pretty, prec, indent + 1);
        if (pretty) sb_push_cstr(out, ",\n");
        first = 0;
      }
      if (pretty && m->size) indent_to(out, indent);
      sb_push_cstr(out, "}");
      return;
    }
    case T_STRUCT: fmt_fields(out, t + 1, ((const Agg *)v)->f, pretty, prec, indent); return;
    case T_ENUM: {
      const Agg *a = (const Agg *)v;
      const u32 *p = t + 3; /* t: kind, name, nvariants, then variants */
      for (u32 i = 0; i < a->tag; i++) p += 3 + 2 * p[2];
      fmt_fields(out, p, a->f, pretty, prec, indent);
      return;
    }
    default:
      sb_push_cstr(out, "<?>");
  }
}
