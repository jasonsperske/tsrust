//! `Vec<T>`: a growable array that owns its elements.
//!
//! The storage itself is native (the VM keeps a JavaScript array), but notice
//! how much of the API is written in plain Rust on top of a few intrinsics.

use crate::fmt::Debug;

pub struct Vec<T>;

impl<T> Vec<T> {
    pub fn new() -> Vec<T>;
    pub fn with_capacity(capacity: usize) -> Vec<T> {
        Vec::new()
    }
    pub fn push(&mut self, value: T);
    pub fn pop(&mut self) -> Option<T>;
    pub fn len(&self) -> usize;
    pub fn clear(&mut self);
    pub fn insert(&mut self, index: usize, element: T);
    pub fn remove(&mut self, index: usize) -> T;
    pub fn swap(&mut self, a: usize, b: usize);
    pub fn truncate(&mut self, len: usize);
    pub fn reverse(&mut self);

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn capacity(&self) -> usize {
        self.len()
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        if index < self.len() {
            Some(&self[index])
        } else {
            None
        }
    }

    pub fn get_mut(&mut self, index: usize) -> Option<&mut T> {
        if index < self.len() {
            Some(&mut self[index])
        } else {
            None
        }
    }

    pub fn first(&self) -> Option<&T> {
        self.get(0)
    }

    pub fn last(&self) -> Option<&T> {
        if self.is_empty() {
            None
        } else {
            self.get(self.len() - 1)
        }
    }

    pub fn append(&mut self, other: &mut Vec<T>) {
        let mut moved = Vec::new();
        while let Some(x) = other.pop() {
            moved.push(x);
        }
        while let Some(x) = moved.pop() {
            self.push(x);
        }
    }

    pub fn as_slice(&self) -> &[T] {
        self
    }

    pub fn as_mut_slice(&mut self) -> &mut [T] {
        self
    }

    pub fn iter(&self) -> crate::slice::Iter<T> {
        self.as_slice().iter()
    }

    pub fn iter_mut(&mut self) -> crate::slice::IterMut<T> {
        self.as_mut_slice().iter_mut()
    }

    /// Build a vector by calling `f` with each index in order.
    pub fn from_fn<F: FnMut(usize) -> T>(length: usize, mut f: F) -> Vec<T> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < length {
            out.push(f(i));
            i += 1;
        }
        out
    }

    pub fn extend<I: IntoIterator<Item = T>>(&mut self, iter: I)
    where
        I::IntoIter: Iterator<Item = T>,
    {
        for x in iter.into_iter() {
            self.push(x);
        }
    }

    pub fn retain<F: FnMut(&T) -> bool>(&mut self, mut keep: F) {
        let n = self.len();
        let mut kept = 0;
        let mut i = 0;
        while i < n {
            if keep(&self[i]) {
                if kept != i {
                    self.swap(kept, i);
                }
                kept += 1;
            }
            i += 1;
        }
        self.truncate(kept);
    }

    pub fn dedup_by_key<K: PartialEq, F: FnMut(&mut T) -> K>(&mut self, mut key: F) {
        let n = self.len();
        if n == 0 {
            return;
        }
        let mut kept = 1;
        let mut i = 1;
        while i < n {
            if key(&mut self[i]) != key(&mut self[kept - 1]) {
                self.swap(kept, i);
                kept += 1;
            }
            i += 1;
        }
        self.truncate(kept);
    }

    pub fn split_off(&mut self, at: usize) -> Vec<T> {
        assert!(at <= self.len(), "`at` split index out of bounds");
        let mut out = Vec::new();
        let mut i = at;
        while i < self.len() {
            out.push(self[i]);
            i += 1;
        }
        self.truncate(at);
        out
    }
}

impl<T: PartialEq> Vec<T> {
    pub fn dedup(&mut self) {
        let n = self.len();
        if n == 0 {
            return;
        }
        let mut kept = 1;
        let mut i = 1;
        while i < n {
            if self[i] != self[kept - 1] {
                self.swap(kept, i);
                kept += 1;
            }
            i += 1;
        }
        self.truncate(kept);
    }
}

impl<T> crate::iter::Extend<T> for Vec<T> {
    fn extend_one(&mut self, item: T) {
        self.push(item);
    }
}

impl<'a, T: Copy> crate::iter::Extend<&'a T> for Vec<T> {
    fn extend_one(&mut self, item: &'a T) {
        self.push(*item);
    }
}

impl<T: Clone> From<&[T]> for Vec<T> {
    fn from(s: &[T]) -> Vec<T> {
        s.to_vec()
    }
}

impl<T: PartialEq> Vec<T> {
    pub fn contains(&self, value: &T) -> bool {
        for item in self.iter() {
            if item == value {
                return true;
            }
        }
        false
    }
}

impl<T: Clone> Vec<T> {
    pub fn extend_from_slice(&mut self, other: &[T]) {
        for item in other.iter() {
            self.push(item.clone());
        }
    }

    pub fn extend_from_vec(&mut self, other: &Vec<T>) {
        for item in other.iter() {
            self.push(item.clone());
        }
    }
}

impl<T: Clone> Clone for Vec<T> {
    fn clone(&self) -> Vec<T> {
        let mut out = Vec::new();
        for item in self.iter() {
            out.push(item.clone());
        }
        out
    }
}

impl<T: PartialEq> PartialEq for Vec<T> {
    fn eq(&self, other: &Vec<T>) -> bool {
        if self.len() != other.len() {
            return false;
        }
        let mut i = 0;
        while i < self.len() {
            if self[i] != other[i] {
                return false;
            }
            i += 1;
        }
        true
    }
}

impl<T: Eq> Eq for Vec<T> {}

impl<T> Default for Vec<T> {
    fn default() -> Vec<T> {
        Vec::new()
    }
}

/// Formatted natively by the VM.
impl<T: Debug> Debug for Vec<T> {
    fn fmt(&self, f: &mut crate::fmt::Formatter) -> crate::fmt::Result;
}

/// Read element `index` without moving it out. Used by `IntoIter`, which owns
/// the vector and never yields the same index twice.
fn take_unchecked<T>(vec: &mut Vec<T>, index: usize) -> T;

/// Owning iterator: `for x in vec` moves each element out.
#[derive(Clone)]
pub struct IntoIter<T> {
    vec: Vec<T>,
    pos: usize,
    end: usize,
}

impl<T> Iterator for IntoIter<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        if self.pos < self.end {
            let index = self.pos;
            self.pos += 1;
            Some(take_unchecked(&mut self.vec, index))
        } else {
            None
        }
    }
}

impl<T> crate::iter::DoubleEndedIterator for IntoIter<T> {
    fn next_back(&mut self) -> Option<T> {
        if self.pos < self.end {
            self.end -= 1;
            Some(take_unchecked(&mut self.vec, self.end))
        } else {
            None
        }
    }
}

impl<T> crate::iter::ExactSizeIterator for IntoIter<T> {
    fn len(&self) -> usize {
        self.end - self.pos
    }
}

impl<T> IntoIterator for Vec<T> {
    type Item = T;
    type IntoIter = IntoIter<T>;
    fn into_iter(self) -> IntoIter<T> {
        let end = self.len();
        IntoIter { vec: self, pos: 0, end: end }
    }
}

impl<'a, T> IntoIterator for &'a Vec<T> {
    type Item = &'a T;
    type IntoIter = crate::slice::Iter<'a, T>;
    fn into_iter(self) -> crate::slice::Iter<'a, T> {
        self.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Vec<T> {
    type Item = &'a mut T;
    type IntoIter = crate::slice::IterMut<'a, T>;
    fn into_iter(self) -> crate::slice::IterMut<'a, T> {
        self.iter_mut()
    }
}

impl<T> crate::iter::FromIterator<T> for Vec<T> {
    fn from_iter<I: Iterator<Item = T>>(iter: I) -> Vec<T> {
        let mut out = Vec::new();
        for x in iter {
            out.push(x);
        }
        out
    }
}
