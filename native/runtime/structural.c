/*
 * TSRust native runtime: structural operations driven by type descriptors.
 *
 * These implement #[derive(PartialEq, PartialOrd, Clone, Hash)] and the
 * built-in impls for tuples, strings and so on: walk two values side by side,
 * using the type descriptor to know what each 64-bit word means.
 */
#include "runtime.h"

static int ref_is_value(V td) { return rt_type(td)[0] == T_STR; }

/* For an enum descriptor, find variant `tag`: returns a pointer to (name, kind, n, fields...). */
static const u32 *enum_variant(const u32 *t, u32 tag) {
  const u32 *p = t + 3;
  for (u32 i = 0; i < tag; i++) p += 3 + 2 * p[2];
  return p;
}

static int str_eq(const Str *a, const Str *b) {
  return a->len == b->len && memcmp(a->ptr, b->ptr, a->len) == 0;
}

int deep_eq(V a, V b, V td) {
  const u32 *t = rt_type(td);
  switch (t[0]) {
    case T_FLOAT: return as_f64(a) == as_f64(b);
    case T_STR: case T_STRING: return str_eq((const Str *)a, (const Str *)b);
    case T_UNIT: return 1;
    case T_REF: return ref_is_value(t[1]) ? deep_eq(a, b, t[1]) : deep_eq(*(V *)a, *(V *)b, t[1]);
    case T_BOX: return deep_eq(*(V *)a, *(V *)b, t[1]);
    case T_TUPLE:
      for (u32 i = 0; i < t[1]; i++) if (!deep_eq(((Agg *)a)->f[i], ((Agg *)b)->f[i], t[2 + i])) return 0;
      return 1;
    case T_STRUCT:
      for (u32 i = 0; i < t[3]; i++) if (!deep_eq(((Agg *)a)->f[i], ((Agg *)b)->f[i], t[5 + 2 * i])) return 0;
      return 1;
    case T_ENUM: {
      const Agg *x = (const Agg *)a, *y = (const Agg *)b;
      if (x->tag != y->tag) return 0;
      const u32 *v = enum_variant(t, x->tag);
      for (u32 i = 0; i < v[2]; i++) if (!deep_eq(x->f[i], y->f[i], v[4 + 2 * i])) return 0;
      return 1;
    }
    case T_VEC: {
      const Vec *x = (const Vec *)a, *y = (const Vec *)b;
      if (x->len != y->len) return 0;
      for (u64 i = 0; i < x->len; i++) if (!deep_eq(x->data[i], y->data[i], t[1])) return 0;
      return 1;
    }
    default: return a == b;
  }
}

static i64 cmp_u(u64 a, u64 b) { return a < b ? -1 : a > b ? 1 : 0; }
static i64 cmp_i(i64 a, i64 b) { return a < b ? -1 : a > b ? 1 : 0; }

i64 deep_cmp(V a, V b, V td) {
  const u32 *t = rt_type(td);
  i64 c;
  switch (t[0]) {
    case T_INT: return t[1] <= K_ISIZE ? cmp_i((i64)a, (i64)b) : cmp_u(a, b);
    case T_FLOAT: {
      double x = as_f64(a), y = as_f64(b);
      return x < y ? -1 : x > y ? 1 : x == y ? 0 : 2; /* 2 = unordered (NaN) */
    }
    case T_STR: case T_STRING: {
      const Str *x = (const Str *)a, *y = (const Str *)b;
      u64 n = x->len < y->len ? x->len : y->len;
      for (u64 i = 0; i < n; i++) if (x->ptr[i] != y->ptr[i]) return x->ptr[i] < y->ptr[i] ? -1 : 1;
      return cmp_u(x->len, y->len);
    }
    case T_UNIT: return 0;
    case T_REF: return ref_is_value(t[1]) ? deep_cmp(a, b, t[1]) : deep_cmp(*(V *)a, *(V *)b, t[1]);
    case T_BOX: return deep_cmp(*(V *)a, *(V *)b, t[1]);
    case T_TUPLE:
      for (u32 i = 0; i < t[1]; i++) if ((c = deep_cmp(((Agg *)a)->f[i], ((Agg *)b)->f[i], t[2 + i]))) return c;
      return 0;
    case T_STRUCT:
      for (u32 i = 0; i < t[3]; i++) if ((c = deep_cmp(((Agg *)a)->f[i], ((Agg *)b)->f[i], t[5 + 2 * i]))) return c;
      return 0;
    case T_ENUM: {
      const Agg *x = (const Agg *)a, *y = (const Agg *)b;
      if (x->tag != y->tag) return x->tag < y->tag ? -1 : 1;
      const u32 *v = enum_variant(t, x->tag);
      for (u32 i = 0; i < v[2]; i++) if ((c = deep_cmp(x->f[i], y->f[i], v[4 + 2 * i]))) return c;
      return 0;
    }
    case T_VEC: {
      const Vec *x = (const Vec *)a, *y = (const Vec *)b;
      u64 n = x->len < y->len ? x->len : y->len;
      for (u64 i = 0; i < n; i++) if ((c = deep_cmp(x->data[i], y->data[i], t[1]))) return c;
      return cmp_u(x->len, y->len);
    }
    default: return cmp_u(a, b); /* bool, char */
  }
}

static V clone_agg(const Agg *a, const u32 *types, int stride, int first) {
  V r = agg_new(a->tag, a->n);
  for (u32 i = 0; i < a->n; i++) ((Agg *)r)->f[i] = deep_clone(a->f[i], types[first + stride * i]);
  return r;
}

V deep_clone(V v, V td) {
  const u32 *t = rt_type(td);
  switch (t[0]) {
    case T_STRING: {
      const StringBuf *s = (const StringBuf *)v;
      StringBuf *c = sb_new();
      sb_push(c, s->ptr, s->len);
      return (V)c;
    }
    case T_BOX: {
      V *cell = rt_alloc(8);
      *cell = deep_clone(*(V *)v, t[1]);
      return (V)cell;
    }
    case T_VEC: {
      const Vec *x = (const Vec *)v;
      Vec *c = vec_new(x->len);
      for (u64 i = 0; i < x->len; i++) vec_push(c, deep_clone(x->data[i], t[1]));
      return (V)c;
    }
    case T_TUPLE: return clone_agg((const Agg *)v, t, 1, 2);
    case T_STRUCT: return clone_agg((const Agg *)v, t, 2, 5);
    case T_ENUM: {
      const Agg *a = (const Agg *)v;
      const u32 *var = enum_variant(t, a->tag);
      return clone_agg(a, var, 2, 4);
    }
    default: return v; /* primitives and shared references are Copy */
  }
}

/* COPY: duplicate a Copy aggregate so the copy can't alias the original. */
V copy_value(V v, V td) {
  const u32 *t = rt_type(td);
  if (t[0] == T_TUPLE || t[0] == T_STRUCT || t[0] == T_ENUM) return deep_clone(v, td);
  return v;
}

static u64 mix(u64 h, u64 x) {
  h ^= x + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2);
  return h * 0xff51afd7ed558ccdull;
}

u64 hash_value(V v, V td) {
  const u32 *t = rt_type(td);
  switch (t[0]) {
    case T_STR: case T_STRING: {
      const Str *s = (const Str *)v;
      u64 h = 1469598103934665603ull;
      for (u64 i = 0; i < s->len; i++) { h ^= s->ptr[i]; h *= 1099511628211ull; }
      return h;
    }
    case T_REF: return ref_is_value(t[1]) ? hash_value(v, t[1]) : hash_value(*(V *)v, t[1]);
    case T_BOX: return hash_value(*(V *)v, t[1]);
    case T_TUPLE: {
      u64 h = 7;
      for (u32 i = 0; i < t[1]; i++) h = mix(h, hash_value(((Agg *)v)->f[i], t[2 + i]));
      return h;
    }
    case T_STRUCT: {
      u64 h = 11;
      for (u32 i = 0; i < t[3]; i++) h = mix(h, hash_value(((Agg *)v)->f[i], t[5 + 2 * i]));
      return h;
    }
    case T_ENUM: {
      const Agg *a = (const Agg *)v;
      const u32 *var = enum_variant(t, a->tag);
      u64 h = mix(13, a->tag);
      for (u32 i = 0; i < var[2]; i++) h = mix(h, hash_value(a->f[i], var[4 + 2 * i]));
      return h;
    }
    default: return mix(0, v);
  }
}
