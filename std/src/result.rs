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

    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Result<U, E> {
        match self {
            Ok(value) => Ok(f(value)),
            Err(e) => Err(e),
        }
    }

    pub fn map_err<O, F: FnOnce(E) -> O>(self, f: F) -> Result<T, O> {
        match self {
            Ok(value) => Ok(value),
            Err(e) => Err(f(e)),
        }
    }

    pub fn map_or<U, F: FnOnce(T) -> U>(self, default: U, f: F) -> U {
        match self {
            Ok(value) => f(value),
            Err(_) => default,
        }
    }

    pub fn and_then<U, F: FnOnce(T) -> Result<U, E>>(self, f: F) -> Result<U, E> {
        match self {
            Ok(value) => f(value),
            Err(e) => Err(e),
        }
    }

    pub fn or_else<O, F: FnOnce(E) -> Result<T, O>>(self, f: F) -> Result<T, O> {
        match self {
            Ok(value) => Ok(value),
            Err(e) => f(e),
        }
    }

    pub fn unwrap_or_else<F: FnOnce(E) -> T>(self, f: F) -> T {
        match self {
            Ok(value) => value,
            Err(e) => f(e),
        }
    }

    pub fn is_ok_and<F: FnOnce(T) -> bool>(self, f: F) -> bool {
        match self {
            Ok(value) => f(value),
            Err(_) => false,
        }
    }

    pub fn is_err_and<F: FnOnce(E) -> bool>(self, f: F) -> bool {
        match self {
            Ok(_) => false,
            Err(e) => f(e),
        }
    }
}

/// Collecting `Result`s stops at the first error.
struct UntilErr<'a, I, E> {
    iter: I,
    error: &'a mut Option<E>,
}

impl<'a, T, E, I: Iterator<Item = Result<T, E>>> Iterator for UntilErr<'a, I, E> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        match self.iter.next() {
            Some(Ok(value)) => Some(value),
            Some(Err(e)) => {
                *self.error = Some(e);
                None
            }
            None => None,
        }
    }
}

impl<A, E, V: crate::iter::FromIterator<A>> crate::iter::FromIterator<Result<A, E>> for Result<V, E> {
    fn from_iter<I: Iterator<Item = Result<A, E>>>(iter: I) -> Result<V, E> {
        let mut error = None;
        let collected = V::from_iter(UntilErr { iter: iter, error: &mut error });
        match error {
            Some(e) => Err(e),
            None => Ok(collected),
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
