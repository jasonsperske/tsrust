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
