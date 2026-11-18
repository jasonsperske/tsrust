//! Slices: `[T]`, a view of consecutive elements. A `&[T]` knows where the
//! elements start and how many there are; it can point into a `Vec`, an array
//! or another slice.

use crate::cmp::Ordering;
use crate::vec::Vec;

impl<T> [T] {
    pub fn len(&self) -> usize;
    pub fn swap(&mut self, a: usize, b: usize);
    pub fn as_ptr(&self) -> *const T;
    pub fn as_mut_ptr(&mut self) -> *mut T;

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn first(&self) -> Option<&T> {
        self.get(0)
    }

    pub fn first_mut(&mut self) -> Option<&mut T> {
        self.get_mut(0)
    }

    pub fn last(&self) -> Option<&T> {
        if self.is_empty() { None } else { self.get(self.len() - 1) }
    }

    pub fn last_mut(&mut self) -> Option<&mut T> {
        if self.is_empty() {
            None
        } else {
            let i = self.len() - 1;
            self.get_mut(i)
        }
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        if index < self.len() { Some(&self[index]) } else { None }
    }

    pub fn get_mut(&mut self, index: usize) -> Option<&mut T> {
        if index < self.len() { Some(&mut self[index]) } else { None }
    }

    pub fn iter(&self) -> Iter<T> {
        Iter { slice: self, front: 0, back: self.len() }
    }

    pub fn iter_mut(&mut self) -> IterMut<T> {
        let back = self.len();
        IterMut { slice: self, front: 0, back: back }
    }

    pub fn reverse(&mut self) {
        let n = self.len();
        let mut i = 0;
        while i < n / 2 {
            self.swap(i, n - 1 - i);
            i += 1;
        }
    }

    pub fn split_at(&self, mid: usize) -> (&[T], &[T]) {
        (&self[..mid], &self[mid..])
    }

    pub fn split_at_mut(&mut self, mid: usize) -> (&mut [T], &mut [T]) {
        let n = self.len();
        assert!(mid <= n, "mid > len");
        let p = self.as_mut_ptr();
        unsafe { (from_raw_parts_mut(p, mid), from_raw_parts_mut(p.add(mid), n - mid)) }
    }

    pub fn split_first(&self) -> Option<(&T, &[T])> {
        if self.is_empty() { None } else { Some((&self[0], &self[1..])) }
    }

    pub fn split_last(&self) -> Option<(&T, &[T])> {
        if self.is_empty() {
            None
        } else {
            let n = self.len() - 1;
            Some((&self[n], &self[..n]))
        }
    }

    pub fn chunks(&self, size: usize) -> Chunks<T> {
        assert!(size != 0, "chunk size must be non-zero");
        Chunks { rest: self, size: size }
    }

    pub fn windows(&self, size: usize) -> Windows<T> {
        assert!(size != 0, "window size must be non-zero");
        Windows { slice: self, size: size, pos: 0 }
    }

    pub fn rotate_left(&mut self, mid: usize) {
        assert!(mid <= self.len());
        self[..mid].reverse();
        self[mid..].reverse();
        self.reverse();
    }

    pub fn rotate_right(&mut self, k: usize) {
        assert!(k <= self.len());
        let mid = self.len() - k;
        self.rotate_left(mid);
    }

    /// A stable merge sort: equal elements keep their order.
    pub fn sort_by<F: FnMut(&T, &T) -> Ordering>(&mut self, mut compare: F) {
        let n = self.len();
        let mut buf: Vec<T> = Vec::new();
        let mut width = 1;
        while width < n {
            let mut lo = 0;
            while lo < n {
                let mid = if lo + width < n { lo + width } else { n };
                let hi = if mid + width < n { mid + width } else { n };
                buf.clear();
                let mut i = lo;
                let mut j = mid;
                while i < mid && j < hi {
                    if compare(&self[j], &self[i]) == Ordering::Less {
                        buf.push(self[j]);
                        j += 1;
                    } else {
                        buf.push(self[i]);
                        i += 1;
                    }
                }
                while i < mid {
                    buf.push(self[i]);
                    i += 1;
                }
                while j < hi {
                    buf.push(self[j]);
                    j += 1;
                }
                let mut k = 0;
                while k < buf.len() {
                    self[lo + k] = buf[k];
                    k += 1;
                }
                lo = hi;
            }
            width *= 2;
        }
    }

    pub fn sort_unstable_by<F: FnMut(&T, &T) -> Ordering>(&mut self, compare: F) {
        self.sort_by(compare);
    }

    pub fn sort_by_key<K: Ord, F: FnMut(&T) -> K>(&mut self, mut key: F) {
        self.sort_by(|a, b| key(a).cmp(&key(b)));
    }

    pub fn sort_unstable_by_key<K: Ord, F: FnMut(&T) -> K>(&mut self, key: F) {
        self.sort_by_key(key);
    }

    pub fn binary_search_by<F: FnMut(&T) -> Ordering>(&self, mut f: F) -> Result<usize, usize> {
        let mut lo = 0;
        let mut hi = self.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            match f(&self[mid]) {
                Ordering::Less => lo = mid + 1,
                Ordering::Greater => hi = mid,
                Ordering::Equal => return Ok(mid),
            }
        }
        Err(lo)
    }

    pub fn iter_position<F: FnMut(&T) -> bool>(&self, mut f: F) -> Option<usize> {
        let mut i = 0;
        while i < self.len() {
            if f(&self[i]) {
                return Some(i);
            }
            i += 1;
        }
        None
    }
}

impl<T: Ord> [T] {
    pub fn sort(&mut self) {
        self.sort_by(|a, b| a.cmp(b));
    }

    pub fn sort_unstable(&mut self) {
        self.sort();
    }

    pub fn binary_search(&self, x: &T) -> Result<usize, usize> {
        self.binary_search_by(|p| p.cmp(x))
    }
}

impl<T: PartialEq> [T] {
    pub fn contains(&self, x: &T) -> bool {
        for item in self.iter() {
            if *item == *x {
                return true;
            }
        }
        false
    }

    pub fn starts_with(&self, needle: &[T]) -> bool {
        let n = needle.len();
        self.len() >= n && eq_slices(&self[..n], needle)
    }

    pub fn ends_with(&self, needle: &[T]) -> bool {
        let (m, n) = (self.len(), needle.len());
        m >= n && eq_slices(&self[m - n..], needle)
    }

    pub fn strip_prefix<P: SlicePattern<Item = T> + ?Sized>(&self, prefix: &P) -> Option<&[T]> {
        let p = prefix.as_slice();
        if self.starts_with(p) { Some(&self[p.len()..]) } else { None }
    }

    pub fn strip_suffix<P: SlicePattern<Item = T> + ?Sized>(&self, suffix: &P) -> Option<&[T]> {
        let p = suffix.as_slice();
        if self.ends_with(p) { Some(&self[..self.len() - p.len()]) } else { None }
    }

    /// Remove `prefix` if it is there; otherwise return the slice unchanged.
    pub fn trim_prefix<P: SlicePattern<Item = T> + ?Sized>(&self, prefix: &P) -> &[T] {
        match self.strip_prefix(prefix) {
            Some(rest) => rest,
            None => self,
        }
    }

    /// Remove `suffix` if it is there; otherwise return the slice unchanged.
    pub fn trim_suffix<P: SlicePattern<Item = T> + ?Sized>(&self, suffix: &P) -> &[T] {
        match self.strip_suffix(suffix) {
            Some(rest) => rest,
            None => self,
        }
    }
}

fn eq_slices<T: PartialEq>(a: &[T], b: &[T]) -> bool {
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

impl<T: Clone> [T] {
    pub fn to_vec(&self) -> Vec<T> {
        let mut out = Vec::new();
        for x in self.iter() {
            out.push(x.clone());
        }
        out
    }

    pub fn fill(&mut self, value: T) {
        let mut i = 0;
        while i < self.len() {
            self[i] = value.clone();
            i += 1;
        }
    }

    pub fn clone_from_slice(&mut self, src: &[T]) {
        assert!(self.len() == src.len(), "destination and source slices have different lengths");
        let mut i = 0;
        while i < self.len() {
            self[i] = src[i].clone();
            i += 1;
        }
    }

    pub fn repeat(&self, n: usize) -> Vec<T> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < n {
            out.extend_from_slice(self);
            i += 1;
        }
        out
    }
}

impl<T: Copy> [T] {
    pub fn copy_from_slice(&mut self, src: &[T]) {
        assert!(self.len() == src.len(), "source slice length does not match destination slice length");
        let mut i = 0;
        while i < self.len() {
            self[i] = src[i];
            i += 1;
        }
    }
}

impl<S: AsRef<str>> [S] {
    pub fn join(&self, separator: &str) -> String {
        let mut out = String::new();
        let mut i = 0;
        while i < self.len() {
            if i > 0 {
                out.push_str(separator);
            }
            out.push_str(self[i].as_ref());
            i += 1;
        }
        out
    }

    pub fn concat(&self) -> String {
        self.join("")
    }
}

/// What `trim_prefix` and friends accept: a slice or an array.
pub trait SlicePattern {
    type Item;
    fn as_slice(&self) -> &[Self::Item];
}

impl<T> SlicePattern for [T] {
    type Item = T;
    fn as_slice(&self) -> &[T] {
        self
    }
}

impl<T, const N: usize> SlicePattern for [T; N] {
    type Item = T;
    fn as_slice(&self) -> &[T] {
        self
    }
}

pub unsafe fn from_raw_parts<'a, T>(data: *const T, len: usize) -> &'a [T];
pub unsafe fn from_raw_parts_mut<'a, T>(data: *mut T, len: usize) -> &'a mut [T];

/// Borrowing iterator: yields `&T`.
pub struct Iter<'a, T> {
    slice: &'a [T],
    front: usize,
    back: usize,
}

impl<'a, T> Iter<'a, T> {
    pub fn as_slice(&self) -> &'a [T] {
        &self.slice[self.front..self.back]
    }
}

impl<'a, T> Clone for Iter<'a, T> {
    fn clone(&self) -> Iter<'a, T> {
        Iter { slice: self.slice, front: self.front, back: self.back }
    }
}

impl<'a, T> Iterator for Iter<'a, T> {
    type Item = &'a T;
    fn next(&mut self) -> Option<&'a T> {
        if self.front < self.back {
            let item = &self.slice[self.front];
            self.front += 1;
            Some(item)
        } else {
            None
        }
    }
}

impl<'a, T> crate::iter::DoubleEndedIterator for Iter<'a, T> {
    fn next_back(&mut self) -> Option<&'a T> {
        if self.front < self.back {
            self.back -= 1;
            Some(&self.slice[self.back])
        } else {
            None
        }
    }
}

impl<'a, T> crate::iter::ExactSizeIterator for Iter<'a, T> {
    fn len(&self) -> usize {
        self.back - self.front
    }
}

/// Mutably borrowing iterator: yields `&mut T`.
pub struct IterMut<'a, T> {
    slice: &'a mut [T],
    front: usize,
    back: usize,
}

impl<'a, T> Iterator for IterMut<'a, T> {
    type Item = &'a mut T;
    fn next(&mut self) -> Option<&'a mut T> {
        if self.front < self.back {
            let item = &mut self.slice[self.front];
            self.front += 1;
            Some(item)
        } else {
            None
        }
    }
}

impl<'a, T> crate::iter::DoubleEndedIterator for IterMut<'a, T> {
    fn next_back(&mut self) -> Option<&'a mut T> {
        if self.front < self.back {
            self.back -= 1;
            Some(&mut self.slice[self.back])
        } else {
            None
        }
    }
}

impl<'a, T> crate::iter::ExactSizeIterator for IterMut<'a, T> {
    fn len(&self) -> usize {
        self.back - self.front
    }
}

pub struct Chunks<'a, T> {
    rest: &'a [T],
    size: usize,
}

impl<'a, T> Iterator for Chunks<'a, T> {
    type Item = &'a [T];
    fn next(&mut self) -> Option<&'a [T]> {
        if self.rest.is_empty() {
            return None;
        }
        let n = if self.size < self.rest.len() { self.size } else { self.rest.len() };
        let (head, tail) = self.rest.split_at(n);
        self.rest = tail;
        Some(head)
    }
}

pub struct Windows<'a, T> {
    slice: &'a [T],
    size: usize,
    pos: usize,
}

impl<'a, T> Iterator for Windows<'a, T> {
    type Item = &'a [T];
    fn next(&mut self) -> Option<&'a [T]> {
        if self.pos + self.size > self.slice.len() {
            return None;
        }
        let w = &self.slice[self.pos..self.pos + self.size];
        self.pos += 1;
        Some(w)
    }
}

impl<'a, T> IntoIterator for &'a [T] {
    type Item = &'a T;
    type IntoIter = Iter<'a, T>;
    fn into_iter(self) -> Iter<'a, T> {
        self.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut [T] {
    type Item = &'a mut T;
    type IntoIter = IterMut<'a, T>;
    fn into_iter(self) -> IterMut<'a, T> {
        self.iter_mut()
    }
}

impl<'a, T> Default for &'a [T] {
    fn default() -> &'a [T] {
        &[]
    }
}
