//! Methods on the primitive `str` type (string slices).

use crate::vec::Vec;

impl str {
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn to_uppercase(&self) -> String;
    pub fn to_lowercase(&self) -> String;
    pub fn to_owned(&self) -> String {
        String::from(self)
    }
    pub fn trim(&self) -> &str;
    pub fn trim_start(&self) -> &str;
    pub fn trim_end(&self) -> &str;
    pub fn contains(&self, pattern: &str) -> bool;
    pub fn starts_with(&self, pattern: &str) -> bool;
    pub fn ends_with(&self, pattern: &str) -> bool;
    pub fn find(&self, pattern: &str) -> Option<usize>;
    pub fn replace(&self, from: &str, to: &str) -> String;
    pub fn repeat(&self, n: usize) -> String;
    pub fn char_count(&self) -> usize;
    /// Substring by byte range, like `&s[start..end]` in real Rust.
    pub fn slice(&self, start: usize, end: usize) -> &str;

    pub fn chars(&self) -> Chars {
        Chars { s: self, pos: 0 }
    }
    pub fn split_whitespace(&self) -> Split {
        Split { parts: split_whitespace_vec(self), pos: 0 }
    }
    pub fn split(&self, separator: &str) -> Split {
        Split { parts: split_vec(self, separator), pos: 0 }
    }
    pub fn lines(&self) -> Split {
        Split { parts: lines_vec(self), pos: 0 }
    }

    /// Parse into any type implementing `FromStr`: `"42".parse::<i32>()`.
    pub fn parse<F: FromStr>(&self) -> Result<F, F::Err> {
        F::from_str(self)
    }
}

fn split_whitespace_vec(s: &str) -> Vec<&str>;
fn split_vec<'a>(s: &'a str, separator: &str) -> Vec<&'a str>;
fn lines_vec(s: &str) -> Vec<&str>;
fn next_char(s: &str, pos: &mut usize) -> Option<char>;

/// Iterator over the `char`s of a string.
pub struct Chars<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> Iterator for Chars<'a> {
    type Item = char;
    fn next(&mut self) -> Option<char> {
        next_char(self.s, &mut self.pos)
    }
}

/// Iterator over pieces of a string.
pub struct Split<'a> {
    parts: Vec<&'a str>,
    pos: usize,
}

impl<'a> Iterator for Split<'a> {
    type Item = &'a str;
    fn next(&mut self) -> Option<&'a str> {
        if self.pos < self.parts.len() {
            let part = self.parts[self.pos];
            self.pos += 1;
            Some(part)
        } else {
            None
        }
    }
}

/// Types that can be parsed from a string.
pub trait FromStr {
    type Err;
    fn from_str(s: &str) -> Result<Self, Self::Err>;
}

/// The error returned when parsing a number fails.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ParseIntError {
    pub message: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ParseFloatError {
    pub message: String,
}

impl crate::fmt::Display for ParseIntError {
    fn fmt(&self, f: &mut crate::fmt::Formatter) -> crate::fmt::Result {
        f.write_str(self.message.as_str())
    }
}

impl crate::fmt::Display for ParseFloatError {
    fn fmt(&self, f: &mut crate::fmt::Formatter) -> crate::fmt::Result {
        f.write_str(self.message.as_str())
    }
}
