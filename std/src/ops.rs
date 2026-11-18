//! Operator traits. `a + b` on a user type calls `Add::add(a, b)`.
//! On primitives the compiler emits a native instruction instead.

pub trait Add<Rhs = Self> {
    type Output;
    fn add(self, rhs: Rhs) -> Self::Output;
}

pub trait Sub<Rhs = Self> {
    type Output;
    fn sub(self, rhs: Rhs) -> Self::Output;
}

pub trait Mul<Rhs = Self> {
    type Output;
    fn mul(self, rhs: Rhs) -> Self::Output;
}

pub trait Div<Rhs = Self> {
    type Output;
    fn div(self, rhs: Rhs) -> Self::Output;
}

pub trait Rem<Rhs = Self> {
    type Output;
    fn rem(self, rhs: Rhs) -> Self::Output;
}

pub trait Neg {
    type Output;
    fn neg(self) -> Self::Output;
}

pub trait AddAssign<Rhs = Self> {
    fn add_assign(&mut self, rhs: Rhs);
}

pub trait SubAssign<Rhs = Self> {
    fn sub_assign(&mut self, rhs: Rhs);
}

pub trait MulAssign<Rhs = Self> {
    fn mul_assign(&mut self, rhs: Rhs);
}

/// Callable by value, at least once. Closures implement these automatically,
/// and `F: Fn(A) -> B` is shorthand for `F: Fn<(A,), Output = B>`.
pub trait FnOnce<Args> {
    type Output;
}

/// Callable repeatedly, possibly changing captured state.
pub trait FnMut<Args>: FnOnce<Args> {}

/// Callable repeatedly through a shared reference.
pub trait Fn<Args>: FnMut<Args> {}

/// `start..`
#[derive(Clone, PartialEq, Eq)]
pub struct RangeFrom<Idx> {
    pub start: Idx,
}

/// `..end`
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RangeTo<Idx> {
    pub end: Idx,
}

/// `..=end`
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RangeToInclusive<Idx> {
    pub end: Idx,
}

/// `..`
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct RangeFull;

/// `start..end`. The compiler builds one of these from range syntax.
#[derive(Clone, PartialEq, Eq)]
pub struct Range<Idx> {
    pub start: Idx,
    pub end: Idx,
}

/// `start..=end`.
#[derive(Clone, PartialEq, Eq)]
pub struct RangeInclusive<Idx> {
    pub start: Idx,
    pub end: Idx,
    pub exhausted: bool,
}

use crate::fmt::{Debug, Formatter, Result as FmtResult};

impl<T: Debug> Debug for Range<T> {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "{:?}..{:?}", self.start, self.end)
    }
}

impl<T: Debug> Debug for RangeInclusive<T> {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "{:?}..={:?}", self.start, self.end)
    }
}

impl<T: Debug> Debug for RangeFrom<T> {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "{:?}..", self.start)
    }
}

impl<T: Debug> Debug for RangeTo<T> {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "..{:?}", self.end)
    }
}

impl<T: Debug> Debug for RangeToInclusive<T> {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "..={:?}", self.end)
    }
}

impl Debug for RangeFull {
    fn fmt(&self, f: &mut Formatter) -> FmtResult {
        write!(f, "..")
    }
}

impl<Idx: PartialOrd> Range<Idx> {
    pub fn contains(&self, item: &Idx) -> bool {
        *item >= self.start && *item < self.end
    }
    pub fn is_empty(&self) -> bool {
        !(self.start < self.end)
    }
}

impl<Idx: PartialOrd> RangeInclusive<Idx> {
    pub fn contains(&self, item: &Idx) -> bool {
        *item >= self.start && *item <= self.end
    }
}
