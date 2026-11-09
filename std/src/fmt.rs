//! Formatting: the machinery behind `println!` and `format!`.
//!
//! `{}` uses the `Display` trait and `{:?}` uses `Debug`. Primitive types,
//! strings and `#[derive(Debug)]` types are formatted natively by the VM; your
//! own `impl Display` is called through the trait like any other method.

/// The output buffer handed to `fmt` methods. Natively it is just a string.
pub struct Formatter;

impl Formatter {
    pub fn write_str(&mut self, s: &str) -> Result {
        crate::fmt::push_str(self, s);
        Ok(())
    }

    /// True for `{:#?}`.
    pub fn alternate(&self) -> bool;
}

fn push_str(f: &mut Formatter, s: &str);

/// The error type of a formatting operation. It carries no information.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Error;

pub type Result = crate::result::Result<(), Error>;

/// User-facing formatting, used by `{}`.
pub trait Display {
    fn fmt(&self, f: &mut Formatter) -> Result;
}

/// Programmer-facing formatting, used by `{:?}`. Usually derived.
pub trait Debug {
    fn fmt(&self, f: &mut Formatter) -> Result;
}
