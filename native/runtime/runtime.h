/*
 * TSRust native runtime: shared definitions.
 *
 * This is the "standard library at the bottom" for native executables, the
 * native counterpart of the TypeScript VM in src/vm. It is freestanding C: no libc, no
 * system headers. All interaction with the operating system goes through
 * three host functions (write, exit, alloc) that the TSRust native backend
 * generates per target OS (Linux and macOS system calls, Windows kernel32).
 *
 * ## Value representation
 *
 * Every Rust value is one 64-bit word (`V`), exactly like a slot of the VM's
 * operand stack:
 *
 *   integers, bool, char   the number itself (normalized to the type's width)
 *   f32 / f64              the IEEE-754 bits of a double
 *   ()                     0
 *   &T, &mut T             the address of the 64-bit slot holding the T
 *   &str                   pointer to a Str        { len, ptr }
 *   String                 pointer to a StringBuf  { len, ptr, cap }
 *   Vec<T>                 pointer to a Vec        { len, data, cap }
 *   Box<T>                 pointer to one 64-bit cell
 *   struct/tuple/enum      pointer to an Agg       { tag, n, fields[n] }
 *   HashMap<K, V>          pointer to a Map
 *
 * Note that StringBuf starts with the same two fields as Str, so a String
 * *is* a valid &str: deref coercion from &String to &str costs nothing.
 *
 * ## Calling convention for generated code
 *
 * Generated code keeps its operand stack on the machine stack. Runtime
 * functions take `V *sp`, a pointer to the top of that stack: sp[0] is the
 * most recently pushed value, sp[1] the one before it, and so on. Extra
 * immediate operands follow in the usual System V argument registers.
 */
#ifndef TSRUST_RUNTIME_H
#define TSRUST_RUNTIME_H

/* Every symbol is hidden, so the compiler addresses them rip-relative instead
 * of through a GOT: the blob then has no absolute addresses at all. */
#pragma GCC visibility push(hidden)

typedef unsigned long long V;
typedef unsigned long long u64;
typedef long long i64;
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;

/* Hidden visibility: referenced rip-relative, never through a GOT (which would hold absolute addresses). */
#define EXPORT __attribute__((used))
#define NORETURN __attribute__((noreturn))

typedef struct { u64 len; const u8 *ptr; } Str;
typedef struct { u64 len; u8 *ptr; u64 cap; } StringBuf;
typedef struct { u64 len; V *data; u64 cap; } Vec;
typedef struct { u32 tag; u32 n; V f[]; } Agg;

typedef struct {
  u64 slots, cap;      /* slots used / allocated in keys, vals, alive */
  V *keys, *vals;
  u8 *alive;
  u64 size;            /* live entries */
  u64 *table;          /* open-addressing hash table of slot index + 1 (0 = empty) */
  u64 tcap;
} Map;

/* Host functions, provided by the per-OS shim in the executable. */
typedef void (*host_write_fn)(i64 fd, const u8 *buf, u64 len);
typedef void (*host_exit_fn)(i64 code);
typedef void *(*host_alloc_fn)(u64 size);

/* Program metadata emitted by the native backend (all fields are offsets from `meta`). */
typedef struct {
  u32 ntypes;
  u32 type_offsets; /* u32[ntypes]: offset of each type descriptor in type_data */
  u32 type_data;    /* u32 words */
  u32 names;        /* name blob: each name is u32 len + bytes, referenced by byte offset */
  u32 strings;      /* Str[nstrings]: string constants; `ptr` initially holds an offset relative to the Str itself */
  u32 nstrings;
} Meta;

/* Type descriptor kinds; must match src/native/compile.ts. */
enum { T_INT, T_FLOAT, T_BOOL, T_CHAR, T_STR, T_STRING, T_UNIT, T_NEVER, T_TUPLE, T_REF, T_BOX, T_VEC, T_MAP, T_STRUCT, T_ENUM, T_OPAQUE };
/* Numeric kinds; must match NUM_KINDS in src/bytecode/opcodes.ts. */
enum { K_I8, K_I16, K_I32, K_I64, K_I128, K_ISIZE, K_U8, K_U16, K_U32, K_U64, K_U128, K_USIZE, K_F32, K_F64, K_BOOL, K_CHAR, K_STR };

/* runtime.c */
void *rt_alloc(u64 size);
NORETURN void rt_panic_str(const u8 *msg, u64 len);
NORETURN void rt_panic_cstr(const char *msg);
const u32 *rt_type(V td);
Str rt_name(u32 off);
void sb_push(StringBuf *s, const u8 *p, u64 n);
void sb_push_cstr(StringBuf *s, const char *c);
void sb_push_char(StringBuf *s, u32 cp);
StringBuf *sb_new(void);
Str *str_new(const u8 *p, u64 n);
Vec *vec_new(u64 cap);
void vec_push(Vec *v, V x);
V agg_new(u32 tag, u32 n);
V some(V x);
V none(void);
u64 utf8_encode(u32 cp, u8 *out);
void *rt_memcpy(void *d, const void *s, u64 n);
void *memcpy(void *d, const void *s, u64 n);
void *memmove(void *d, const void *s, u64 n);
void *memset(void *d, int c, u64 n);
int memcmp(const void *a, const void *b, u64 n);
NORETURN void rt_exit(i64 code);
NORETURN void rt_panic_kind(i64 kind);
NORETURN void rt_index_fail(V len, V index);

/* format.c */
void fmt_value(StringBuf *out, V v, V td, int debug, int pretty, i64 prec, int indent);
void fmt_f64(StringBuf *out, double d, int debug, i64 prec);
void fmt_i64(StringBuf *out, i64 v);
void fmt_u64(StringBuf *out, u64 v);
int parse_f64(const u8 *p, u64 n, double *out);

/* structural.c */
int deep_eq(V a, V b, V td);
i64 deep_cmp(V a, V b, V td);
V deep_clone(V v, V td);
V copy_value(V v, V td);
u64 hash_value(V v, V td);

static inline double as_f64(V v) { union { V v; double d; } u; u.v = v; return u.d; }
static inline V from_f64(double d) { union { V v; double d; } u; u.d = d; return u.v; }

#pragma GCC visibility pop
#endif
