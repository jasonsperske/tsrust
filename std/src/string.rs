//! `String`: an owned, growable UTF-8 string.
//!
//! `String` *derefs* to `str`, so every `str` method (`len`, `contains`,
//! `trim`, ...) works on a `String` too, and a `&String` coerces to a `&str`
//! wherever one is expected.

use crate::fmt::{Display, Formatter};

pub struct String;

impl String {
    pub fn new() -> String;
    pub fn from(s: &str) -> String;
    pub fn with_capacity(capacity: usize) -> String {
        String::new()
    }
    pub fn push_str(&mut self, s: &str);
    pub fn push(&mut self, c: char);
    pub fn as_str(&self) -> &str;
    pub fn clear(&mut self);
    pub fn insert(&mut self, index: usize, c: char);
    pub fn truncate(&mut self, new_len: usize);
    pub fn pop(&mut self) -> Option<char>;
    pub fn remove(&mut self, index: usize) -> char;
    pub fn capacity(&self) -> usize {
        self.len()
    }
}

impl Clone for String {
    fn clone(&self) -> String {
        String::from(self.as_str())
    }
}

impl Default for String {
    fn default() -> String {
        String::new()
    }
}

/// `String + &str` consumes the left string and appends to it.
impl crate::ops::Add<&str> for String {
    type Output = String;
    fn add(mut self, rhs: &str) -> String {
        self.push_str(rhs);
        self
    }
}

impl crate::ops::AddAssign<&str> for String {
    fn add_assign(&mut self, rhs: &str) {
        self.push_str(rhs);
    }
}

/// Anything that can be displayed can be turned into a `String`.
pub trait ToString {
    fn to_string(&self) -> String;
}

/// A *blanket implementation*: one impl that covers every `T: Display`.
impl<T: Display + ?Sized> ToString for T {
    fn to_string(&self) -> String {
        format!("{}", self)
    }
}

impl crate::iter::FromIterator<char> for String {
    fn from_iter<I: Iterator<Item = char>>(iter: I) -> String {
        let mut s = String::new();
        for c in iter {
            s.push(c);
        }
        s
    }
}

impl<'a> crate::iter::FromIterator<&'a str> for String {
    fn from_iter<I: Iterator<Item = &'a str>>(iter: I) -> String {
        let mut s = String::new();
        for part in iter {
            s.push_str(part);
        }
        s
    }
}
