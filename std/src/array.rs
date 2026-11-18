//! Arrays: `[T; N]`, exactly `N` elements stored inline. Anything a slice can
//! do, an array can do too: method calls reach `[T]` automatically.

use crate::vec::Vec;

fn into_vec<T, const N: usize>(array: [T; N]) -> Vec<T>;
fn from_vec<T, const N: usize>(vec: Vec<T>) -> [T; N];

impl<T, const N: usize> [T; N] {
    pub fn as_slice(&self) -> &[T] {
        self
    }

    pub fn as_mut_slice(&mut self) -> &mut [T] {
        self
    }

    pub fn map<U, F: FnMut(T) -> U>(self, mut f: F) -> [U; N] {
        let mut out = Vec::new();
        for x in into_vec(self) {
            out.push(f(x));
        }
        from_vec(out)
    }
}

/// Build an array by calling `f` with each index.
pub fn from_fn<T, const N: usize, F: FnMut(usize) -> T>(mut f: F) -> [T; N] {
    let mut out = Vec::new();
    let mut i = 0;
    while i < N {
        out.push(f(i));
        i += 1;
    }
    from_vec(out)
}

impl<T, const N: usize> IntoIterator for [T; N] {
    type Item = T;
    type IntoIter = crate::vec::IntoIter<T>;
    fn into_iter(self) -> crate::vec::IntoIter<T> {
        into_vec(self).into_iter()
    }
}

impl<'a, T, const N: usize> IntoIterator for &'a [T; N] {
    type Item = &'a T;
    type IntoIter = crate::slice::Iter<'a, T>;
    fn into_iter(self) -> crate::slice::Iter<'a, T> {
        self.iter()
    }
}

impl<'a, T, const N: usize> IntoIterator for &'a mut [T; N] {
    type Item = &'a mut T;
    type IntoIter = crate::slice::IterMut<'a, T>;
    fn into_iter(self) -> crate::slice::IterMut<'a, T> {
        self.iter_mut()
    }
}

impl<T, const N: usize> From<[T; N]> for Vec<T> {
    fn from(array: [T; N]) -> Vec<T> {
        into_vec(array)
    }
}
