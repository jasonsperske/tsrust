/**
 * Generates two things:
 *
 * 1. `std/src/num.rs` — impls repeated for every numeric type (Rust's real
 *    standard library uses `macro_rules!` for this; TSRust has no macro_rules,
 *    so we generate the text instead).
 * 2. `src/std/bundle.ts` — every file under `std/` embedded as a string, so the
 *    compiler can load the standard library without a filesystem (e.g. in the
 *    browser playground).
 *
 * Run with `npm run gen`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");

const SIGNED = ["i8", "i16", "i32", "i64", "isize"];
const UNSIGNED = ["u8", "u16", "u32", "u64", "usize"];
const FLOATS = ["f32", "f64"];
const BOUNDS: Record<string, [string, string]> = {
  i8: ["-128", "127"], i16: ["-32768", "32767"], i32: ["-2147483648", "2147483647"],
  i64: ["-9007199254740991", "9007199254740991"], isize: ["-9007199254740991", "9007199254740991"],
  u8: ["0", "255"], u16: ["0", "65535"], u32: ["0", "4294967295"],
  u64: ["0", "9007199254740991"], usize: ["0", "9007199254740991"],
};

function intImpl(t: string, signed: boolean): string {
  const [min, max] = BOUNDS[t];
  return `
impl ${t} {
    pub const MIN: ${t} = ${min};
    pub const MAX: ${t} = ${max};
    pub fn pow(self, exp: u32) -> ${t};
    pub fn checked_add(self, rhs: ${t}) -> Option<${t}>;
    pub fn checked_sub(self, rhs: ${t}) -> Option<${t}>;
    pub fn checked_mul(self, rhs: ${t}) -> Option<${t}>;
    pub fn checked_div(self, rhs: ${t}) -> Option<${t}>;
    pub fn wrapping_add(self, rhs: ${t}) -> ${t};
    pub fn wrapping_sub(self, rhs: ${t}) -> ${t};
    pub fn wrapping_mul(self, rhs: ${t}) -> ${t};
    pub fn saturating_add(self, rhs: ${t}) -> ${t};
    pub fn saturating_sub(self, rhs: ${t}) -> ${t};
    pub fn rem_euclid(self, rhs: ${t}) -> ${t};
${signed ? `    pub fn abs(self) -> ${t};
    pub fn signum(self) -> ${t};
    pub fn is_positive(self) -> bool { self > 0 }
    pub fn is_negative(self) -> bool { self < 0 }
` : `    pub fn is_power_of_two(self) -> bool;
`}}

impl Step for ${t} {
    fn forward(self) -> ${t} {
        self + 1
    }
}

fn parse_${t}(s: &str) -> Option<${t}>;

impl FromStr for ${t} {
    type Err = ParseIntError;
    fn from_str(s: &str) -> Result<${t}, ParseIntError> {
        match parse_${t}(s) {
            Some(value) => Ok(value),
            None => Err(ParseIntError { message: String::from("invalid digit found in string") }),
        }
    }
}
${sumProduct(t, "0", "1")}`;
}

function sumProduct(t: string, zero: string, one: string): string {
  return `
impl Sum<${t}> for ${t} {
    fn sum<I: Iterator<Item = ${t}>>(iter: I) -> ${t} {
        let mut total: ${t} = ${zero};
        for x in iter { total += x; }
        total
    }
}

impl<'a> Sum<&'a ${t}> for ${t} {
    fn sum<I: Iterator<Item = &'a ${t}>>(iter: I) -> ${t} {
        let mut total: ${t} = ${zero};
        for x in iter { total += *x; }
        total
    }
}

impl Product<${t}> for ${t} {
    fn product<I: Iterator<Item = ${t}>>(iter: I) -> ${t} {
        let mut total: ${t} = ${one};
        for x in iter { total *= x; }
        total
    }
}
`;
}

function floatImpl(t: string): string {
  return `
impl ${t} {
    pub const MAX: ${t} = 1.7976931348623157e308;
    pub const MIN: ${t} = -1.7976931348623157e308;
    pub const EPSILON: ${t} = 2.220446049250313e-16;
    pub fn sqrt(self) -> ${t};
    pub fn abs(self) -> ${t};
    pub fn powi(self, n: i32) -> ${t};
    pub fn powf(self, n: ${t}) -> ${t};
    pub fn floor(self) -> ${t};
    pub fn ceil(self) -> ${t};
    pub fn round(self) -> ${t};
    pub fn trunc(self) -> ${t};
    pub fn sin(self) -> ${t};
    pub fn cos(self) -> ${t};
    pub fn tan(self) -> ${t};
    pub fn atan2(self, other: ${t}) -> ${t};
    pub fn exp(self) -> ${t};
    pub fn ln(self) -> ${t};
    pub fn log10(self) -> ${t};
    pub fn min(self, other: ${t}) -> ${t};
    pub fn max(self, other: ${t}) -> ${t};
    pub fn is_nan(self) -> bool;
    pub fn signum(self) -> ${t};
    pub fn to_degrees(self) -> ${t};
    pub fn to_radians(self) -> ${t};
}

fn parse_${t}(s: &str) -> Option<${t}>;

impl FromStr for ${t} {
    type Err = ParseFloatError;
    fn from_str(s: &str) -> Result<${t}, ParseFloatError> {
        match parse_${t}(s) {
            Some(value) => Ok(value),
            None => Err(ParseFloatError { message: String::from("invalid float literal") }),
        }
    }
}
${sumProduct(t, "0.0", "1.0")}`;
}

const charImpl = `
impl char {
    pub fn is_alphabetic(self) -> bool;
    pub fn is_numeric(self) -> bool;
    pub fn is_alphanumeric(self) -> bool;
    pub fn is_whitespace(self) -> bool;
    pub fn is_uppercase(self) -> bool;
    pub fn is_lowercase(self) -> bool;
    pub fn is_ascii_digit(self) -> bool;
    pub fn is_ascii_punctuation(self) -> bool;
    pub fn to_ascii_uppercase(self) -> char;
    pub fn to_ascii_lowercase(self) -> char;
    pub fn to_digit(self, radix: u32) -> Option<u32>;
    pub fn is_digit(self, radix: u32) -> bool {
        self.to_digit(radix).is_some()
    }
    pub fn len_utf8(self) -> usize;
}

impl FromStr for bool {
    type Err = ParseIntError;
    fn from_str(s: &str) -> Result<bool, ParseIntError> {
        if s == "true" {
            Ok(true)
        } else if s == "false" {
            Ok(false)
        } else {
            Err(ParseIntError { message: String::from("provided string was not \`true\` or \`false\`") })
        }
    }
}
`;

function genNum(): string {
  return [
    "//! Methods, constants and trait impls for the numeric primitive types.",
    "//!",
    "//! GENERATED by scripts/gen-std.ts: edit the generator, not this file.",
    "",
    "use crate::iter::{Iterator, Product, Step, Sum};",
    "use crate::str::{FromStr, ParseFloatError, ParseIntError};",
    ...SIGNED.map((t) => intImpl(t, true)),
    ...UNSIGNED.map((t) => intImpl(t, false)),
    ...FLOATS.map(floatImpl),
    charImpl,
    "pub mod consts {",
    "    pub const PI: f64 = 3.141592653589793;",
    "    pub const E: f64 = 2.718281828459045;",
    "    pub const TAU: f64 = 6.283185307179586;",
    "    pub const SQRT_2: f64 = 1.4142135623730951;",
    "}",
    "",
  ].join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

writeFileSync(join(root, "std/src/num.rs"), genNum());

const files: Record<string, string> = {};
for (const file of walk(join(root, "std")).sort()) {
  files[relative(join(root, "std"), file).split("\\").join("/")] = readFileSync(file, "utf8");
}
mkdirSync(join(root, "src/std"), { recursive: true });
writeFileSync(
  join(root, "src/std/bundle.ts"),
  `/**\n * The TSRust standard library sources, embedded so the compiler works without a filesystem.\n * GENERATED by scripts/gen-std.ts from the files in /std. Do not edit by hand.\n */\nexport const STD_FILES: Record<string, string> = ${JSON.stringify(files, null, 2)};\n`,
);
console.log(`bundled ${Object.keys(files).length} std files`);
