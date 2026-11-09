//! `Result<T, E>`: success or failure, as a value. The `?` operator unwraps an
//! `Ok` or returns the `Err` early from the enclosing function.

use crate::fmt::Debug;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Result<T, E> {
    Ok(T),
    Err(E),
}

impl<T, E> Result<T, E> {
    pub fn is_ok(&self) -> bool {
        match self {
            Ok(_) => true,
            Err(_) => false,
        }
    }

    pub fn is_err(&self) -> bool {
        !self.is_ok()
    }

    pub fn ok(self) -> Option<T> {
        match self {
            Ok(value) => Some(value),
            Err(_) => None,
        }
    }

    pub fn err(self) -> Option<E> {
        match self {
            Ok(_) => None,
            Err(e) => Some(e),
        }
    }

    pub fn unwrap_or(self, default: T) -> T {
        match self {
            Ok(value) => value,
            Err(_) => default,
        }
    }

    pub fn as_ref(&self) -> Result<&T, &E> {
        match self {
            Ok(value) => Ok(value),
            Err(e) => Err(e),
        }
    }
}

/// These methods need to print the error, so they only exist when `E: Debug`.
/// Splitting an `impl` by bounds like this is a common Rust pattern.
impl<T, E: Debug> Result<T, E> {
    pub fn unwrap(self) -> T {
        match self {
            Ok(value) => value,
            Err(e) => panic!("called `Result::unwrap()` on an `Err` value: {:?}", e),
        }
    }

    pub fn expect(self, msg: &str) -> T {
        match self {
            Ok(value) => value,
            Err(e) => panic!("{}: {:?}", msg, e),
        }
    }
}

impl<T: Debug, E> Result<T, E> {
    pub fn unwrap_err(self) -> E {
        match self {
            Ok(value) => panic!("called `Result::unwrap_err()` on an `Ok` value: {:?}", value),
            Err(e) => e,
        }
    }
}
