//! # The TSRust standard library
//!
//! This crate is compiled by TSRust itself, exactly like user code. Most of it
//! is ordinary Rust: `Option`, `Result`, iterators, `Vec::get`...
//!
//! At the very bottom are **intrinsics**: functions declared without a body,
//! like `pub fn push(&mut self, value: T);`. The code generator turns a call
//! to an intrinsic into a single `INTRINSIC` bytecode instruction that the VM
//! implements in TypeScript. Only this crate may declare them.
//!
//! Every crate gets `std::prelude::*` imported automatically, which is why
//! user code can say `Some(5)` and `Vec::new()` without any `use`.

pub mod boxed;
pub mod clone;
pub mod cmp;
pub mod collections;
pub mod convert;
pub mod default;
pub mod fmt;
pub mod iter;
pub mod marker;
pub mod mem;
pub mod num;
pub mod ops;
pub mod option;
pub mod prelude;
pub mod process;
pub mod result;
pub mod str;
pub mod string;
pub mod vec;

/// `std::f64::consts::PI` and friends.
pub mod f64 {
    pub use crate::num::consts;
}
