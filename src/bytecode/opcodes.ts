/**
 * # The TSRust instruction set
 *
 * TSRust compiles to bytecode for a **stack machine**: instructions pop their
 * inputs from an operand stack and push their results. `a + b * c` becomes:
 *
 * ```text
 * LOAD a        stack: [a]
 * LOAD b        stack: [a, b]
 * LOAD c        stack: [a, b, c]
 * MUL i32       stack: [a, b*c]
 * ADD i32       stack: [a+b*c]
 * ```
 *
 * Every function has numbered **local slots** (parameters first). Memory
 * *places* are reached through `Ref` values: `REF_LOCAL 3` pushes a reference
 * to slot 3, `FIELD_REF 1` turns a reference to a struct into a reference to
 * its second field, and `LOAD_REF`/`STORE_REF` read and write through a
 * reference. That's all `&`, `&mut` and `*` need.
 *
 * Instructions are stored as a flat array: an opcode followed by its
 * operands. The table below is the single source of truth used by the code
 * generator, the binary writer/reader, the disassembler and the VM.
 */

export interface OpInfo {
  name: string;
  /** Names of the inline operands, for the disassembler. */
  operands: string[];
  doc: string;
}

const table = {
  NOP: { operands: [], doc: "do nothing" },
  CONST: { operands: ["const"], doc: "push constant-pool entry: an integer, or a string (a `&str`)" },
  CONST_F: { operands: ["const"], doc: "push a floating-point constant" },
  CONST_CHAR: { operands: ["const"], doc: "push a `char` constant (stored as a one-character string)" },
  UNIT: { operands: [], doc: "push the unit value ()" },
  TRUE: { operands: [], doc: "push true" },
  FALSE: { operands: [], doc: "push false" },
  POP: { operands: [], doc: "discard the top of the stack" },
  DUP: { operands: [], doc: "duplicate the top of the stack" },

  LOAD: { operands: ["slot"], doc: "push the value in a local slot" },
  STORE: { operands: ["slot"], doc: "pop a value into a local slot" },
  REF_LOCAL: { operands: ["slot"], doc: "push a reference to a local slot (&x)" },
  LOAD_REF: { operands: [], doc: "pop a reference, push the value it points to (*r)" },
  STORE_REF: { operands: [], doc: "pop value and reference, write the value through it (*r = v)" },
  FIELD_REF: { operands: ["field"], doc: "pop &struct, push &struct.field" },
  DEREF_REF: { operands: [], doc: "pop &T where T is a reference or Box, push a reference to its target" },
  STR_REF: { operands: [], doc: "pop &String (or &&str), push &str (deref coercion)" },
  STR_OF: { operands: [], doc: "pop a String value, push it viewed as &str" },
  INDEX_REF: { operands: [], doc: "pop index and &Vec, push &vec[index] (bounds-checked)" },
  INDEX_GET: { operands: [], doc: "pop index and Vec, push vec[index] (bounds-checked)" },

  MAKE_AGG: { operands: ["tag", "count"], doc: "pop `count` values into a struct/tuple/enum variant with the given tag" },
  GET_FIELD: { operands: ["field"], doc: "pop an aggregate, push one of its fields" },
  GET_TAG: { operands: [], doc: "pop an enum value, push its variant index" },
  GET_BOX: { operands: [], doc: "pop a Box, push its contents" },
  COPY: { operands: ["type"], doc: "pop an aggregate, push a deep copy (for Copy types)" },

  ADD: { operands: ["num"], doc: "pop b, a; push a + b (checked for overflow)" },
  SUB: { operands: ["num"], doc: "pop b, a; push a - b (checked)" },
  MUL: { operands: ["num"], doc: "pop b, a; push a * b (checked)" },
  DIV: { operands: ["num"], doc: "pop b, a; push a / b (checked, panics on zero)" },
  REM: { operands: ["num"], doc: "pop b, a; push a % b" },
  NEG: { operands: ["num"], doc: "pop a; push -a" },
  NOT: { operands: ["num"], doc: "pop a; push !a (bitwise for integers, logical for bool)" },
  BITAND: { operands: ["num"], doc: "bitwise and" },
  BITOR: { operands: ["num"], doc: "bitwise or" },
  BITXOR: { operands: ["num"], doc: "bitwise xor" },
  SHL: { operands: ["num"], doc: "shift left" },
  SHR: { operands: ["num"], doc: "shift right" },
  CAST: { operands: ["from", "to"], doc: "numeric `as` conversion" },

  EQ: { operands: ["num"], doc: "primitive equality (numbers, bools, chars, or `&str` for kind str)" },
  NE: { operands: ["num"], doc: "primitive inequality" },
  LT: { operands: ["num"], doc: "primitive <" },
  LE: { operands: ["num"], doc: "primitive <=" },
  GT: { operands: ["num"], doc: "primitive >" },
  GE: { operands: ["num"], doc: "primitive >=" },
  DEEP_EQ: { operands: ["type"], doc: "structural equality (#[derive(PartialEq)], String, tuples...)" },
  DEEP_CMP: { operands: ["type"], doc: "structural comparison; pushes -1, 0 or 1" },
  CLONE: { operands: ["type"], doc: "structural deep clone (#[derive(Clone)])" },
  DEFAULT: { operands: ["type"], doc: "push the default value of a primitive type" },

  JUMP: { operands: ["target"], doc: "jump" },
  JUMP_IF_FALSE: { operands: ["target"], doc: "pop a bool; jump if false" },
  JUMP_IF_TRUE: { operands: ["target"], doc: "pop a bool; jump if true" },
  CALL: { operands: ["fn", "argc"], doc: "call a bytecode function" },
  RET: { operands: [], doc: "return the top of the stack to the caller" },
  INTRINSIC: { operands: ["intrinsic", "argc"], doc: "call a native function implemented by the VM" },
  PANIC: { operands: [], doc: "pop a message and panic" },
  UNREACHABLE: { operands: [], doc: "trap: control should never get here" },

  NEW_STRING: { operands: [], doc: "push a new empty String" },
  STR_APPEND: { operands: [], doc: "pop &str and String; append (String stays referenced elsewhere)" },
  FMT: { operands: ["type", "flags", "precision"], doc: "pop value and String; append the value formatted with Display (flags&1 = Debug, flags&2 = pretty)" },
  PRINT: { operands: ["flags"], doc: "pop a String and print it (flags&1 = newline, flags&2 = stderr)" },
} as const;

export type OpName = keyof typeof table;

export const OPS: OpInfo[] = Object.entries(table).map(([name, info]) => ({ name, operands: [...info.operands], doc: info.doc }));

/** Opcode numbers, e.g. `Op.ADD`. */
export const Op = Object.fromEntries(OPS.map((o, i) => [o.name, i])) as Record<OpName, number>;

/** Numeric kinds used as the `num` operand of arithmetic instructions. */
export const NUM_KINDS = ["i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "bool", "char", "str"] as const;
export type NumKind = (typeof NUM_KINDS)[number];
