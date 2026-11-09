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

    pub fn iter(&self) -> Iter<T> {
        Iter { vec: self, pos: 0 }
    }

    pub fn iter_mut(&mut self) -> IterMut<T> {
        IterMut { vec: self, pos: 0 }
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

impl<T: Ord> Vec<T> {
    /// Insertion sort, written in Rust. Uses `Ord::cmp` on the elements.
    pub fn sort(&mut self) {
        let mut i = 1;
        while i < self.len() {
            let mut j = i;
            while j > 0 && self[j - 1] > self[j] {
                self.swap(j - 1, j);
                j -= 1;
            }
            i += 1;
        }
    }
}

impl<T: Clone> Vec<T> {
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

/// Borrowing iterator: yields `&T`.
pub struct Iter<'a, T> {
    vec: &'a Vec<T>,
    pos: usize,
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;
    fn next(&mut self) -> Option<&'a T> {
        if self.pos < self.vec.len() {
            let item = &self.vec[self.pos];
            self.pos += 1;
            Some(item)
        } else {
            None
        }
    }
}

/// Mutably borrowing iterator: yields `&mut T`.
pub struct IterMut<'a, T> {
    vec: &'a mut Vec<T>,
    pos: usize,
}

impl<'a, T> Iterator for IterMut<'a, T> {
    type Item = &'a mut T;
    fn next(&mut self) -> Option<&'a mut T> {
        if self.pos < self.vec.len() {
            let item = &mut self.vec[self.pos];
            self.pos += 1;
            Some(item)
        } else {
            None
        }
    }
}

/// Owning iterator: `for x in vec` moves each element out.
pub struct IntoIter<T> {
    vec: Vec<T>,
    pos: usize,
}

impl<T> Iterator for IntoIter<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        if self.pos < self.vec.len() {
            let index = self.pos;
            self.pos += 1;
            Some(take_unchecked(&mut self.vec, index))
        } else {
            None
        }
    }
}

impl<T> IntoIterator for Vec<T> {
    type Item = T;
    type IntoIter = IntoIter<T>;
    fn into_iter(self) -> IntoIter<T> {
        IntoIter { vec: self, pos: 0 }
    }
}

impl<'a, T> IntoIterator for &'a Vec<T> {
    type Item = &'a T;
    type IntoIter = Iter<'a, T>;
    fn into_iter(self) -> Iter<'a, T> {
        self.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Vec<T> {
    type Item = &'a mut T;
    type IntoIter = IterMut<'a, T>;
    fn into_iter(self) -> IterMut<'a, T> {
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
