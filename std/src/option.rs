//! `Option<T>`: a value that might be absent. Rust has no `null`; absence is
//! an ordinary enum variant the type checker forces you to handle.

use crate::fmt::Debug;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Option<T> {
    None,
    Some(T),
}

impl<T> Option<T> {
    pub fn is_some(&self) -> bool {
        match self {
            Some(_) => true,
            None => false,
        }
    }

    pub fn is_none(&self) -> bool {
        !self.is_some()
    }

    pub fn unwrap(self) -> T {
        match self {
            Some(value) => value,
            None => panic!("called `Option::unwrap()` on a `None` value"),
        }
    }

    pub fn expect(self, msg: &str) -> T {
        match self {
            Some(value) => value,
            None => panic!("{}", msg),
        }
    }

    pub fn unwrap_or(self, default: T) -> T {
        match self {
            Some(value) => value,
            None => default,
        }
    }

    pub fn ok_or<E>(self, err: E) -> Result<T, E> {
        match self {
            Some(value) => Ok(value),
            None => Err(err),
        }
    }

    /// `&Option<T>` to `Option<&T>`. Note how `match self` with `self: &Self`
    /// binds `value` as `&T` automatically ("match ergonomics").
    pub fn as_ref(&self) -> Option<&T> {
        match self {
            Some(value) => Some(value),
            None => None,
        }
    }

    pub fn as_mut(&mut self) -> Option<&mut T> {
        match self {
            Some(value) => Some(value),
            None => None,
        }
    }

    /// Take the value out, leaving `None` in its place.
    pub fn take(&mut self) -> Option<T> {
        crate::mem::replace(self, None)
    }

    pub fn replace(&mut self, value: T) -> Option<T> {
        crate::mem::replace(self, Some(value))
    }

    pub fn or(self, other: Option<T>) -> Option<T> {
        match self {
            Some(value) => Some(value),
            None => other,
        }
    }

    pub fn and<U>(self, other: Option<U>) -> Option<U> {
        match self {
            Some(_) => other,
            None => None,
        }
    }

    pub fn iter(&self) -> crate::option::Iter<T> {
        crate::option::Iter { inner: self.as_ref() }
    }

    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Option<U> {
        match self {
            Some(value) => Some(f(value)),
            None => None,
        }
    }

    pub fn inspect<F: FnOnce(&T)>(self, f: F) -> Option<T> {
        if let Some(value) = &self {
            f(value);
        }
        self
    }

    pub fn map_or<U, F: FnOnce(T) -> U>(self, default: U, f: F) -> U {
        match self {
            Some(value) => f(value),
            None => default,
        }
    }

    pub fn map_or_else<U, D: FnOnce() -> U, F: FnOnce(T) -> U>(self, default: D, f: F) -> U {
        match self {
            Some(value) => f(value),
            None => default(),
        }
    }

    pub fn and_then<U, F: FnOnce(T) -> Option<U>>(self, f: F) -> Option<U> {
        match self {
            Some(value) => f(value),
            None => None,
        }
    }

    pub fn or_else<F: FnOnce() -> Option<T>>(self, f: F) -> Option<T> {
        match self {
            Some(value) => Some(value),
            None => f(),
        }
    }

    pub fn filter<P: FnOnce(&T) -> bool>(self, predicate: P) -> Option<T> {
        if let Some(value) = self {
            if predicate(&value) {
                return Some(value);
            }
        }
        None
    }

    pub fn unwrap_or_else<F: FnOnce() -> T>(self, f: F) -> T {
        match self {
            Some(value) => value,
            None => f(),
        }
    }

    pub fn ok_or_else<E, F: FnOnce() -> E>(self, err: F) -> Result<T, E> {
        match self {
            Some(value) => Ok(value),
            None => Err(err()),
        }
    }

    pub fn is_some_and<F: FnOnce(T) -> bool>(self, f: F) -> bool {
        match self {
            Some(value) => f(value),
            None => false,
        }
    }

    pub fn is_none_or<F: FnOnce(T) -> bool>(self, f: F) -> bool {
        match self {
            Some(value) => f(value),
            None => true,
        }
    }

    pub fn get_or_insert_with<F: FnOnce() -> T>(&mut self, f: F) -> &mut T {
        if self.is_none() {
            *self = Some(f());
        }
        match self {
            Some(value) => value,
            None => unreachable!(),
        }
    }

    pub fn zip<U>(self, other: Option<U>) -> Option<(T, U)> {
        match (self, other) {
            (Some(a), Some(b)) => Some((a, b)),
            _ => None,
        }
    }
}

/// Collecting `Option`s stops at the first `None`.
struct UntilNone<'a, I> {
    iter: I,
    failed: &'a mut bool,
}

impl<'a, T, I: Iterator<Item = Option<T>>> Iterator for UntilNone<'a, I> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        match self.iter.next() {
            Some(Some(value)) => Some(value),
            Some(None) => {
                *self.failed = true;
                None
            }
            None => None,
        }
    }
}

impl<A, V: crate::iter::FromIterator<A>> crate::iter::FromIterator<Option<A>> for Option<V> {
    fn from_iter<I: Iterator<Item = Option<A>>>(iter: I) -> Option<V> {
        let mut failed = false;
        let collected = V::from_iter(UntilNone { iter: iter, failed: &mut failed });
        if failed { None } else { Some(collected) }
    }
}

/// Owning iterator over the zero or one values of an `Option`.
#[derive(Clone)]
pub struct IntoIter<T> {
    inner: Option<T>,
}

impl<T> Iterator for IntoIter<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        self.inner.take()
    }
}

impl<T> IntoIterator for Option<T> {
    type Item = T;
    type IntoIter = IntoIter<T>;
    fn into_iter(self) -> IntoIter<T> {
        IntoIter { inner: self }
    }
}

impl<T: Default> Option<T> {
    pub fn unwrap_or_default(self) -> T {
        match self {
            Some(value) => value,
            None => T::default(),
        }
    }
}

impl<T: Clone> Option<&T> {
    pub fn cloned(self) -> Option<T> {
        match self {
            Some(value) => Some(value.clone()),
            None => None,
        }
    }
}

impl<T: Copy> Option<&T> {
    pub fn copied(self) -> Option<T> {
        match self {
            Some(value) => Some(*value),
            None => None,
        }
    }
}

impl<T> Default for Option<T> {
    fn default() -> Option<T> {
        None
    }
}

pub struct Iter<'a, T> {
    inner: Option<&'a T>,
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;
    fn next(&mut self) -> Option<&'a T> {
        self.inner.take()
    }
}
