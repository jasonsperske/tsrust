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

/// `start..end`. The compiler builds one of these from range syntax.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Range<Idx> {
    pub start: Idx,
    pub end: Idx,
}

/// `start..=end`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RangeInclusive<Idx> {
    pub start: Idx,
    pub end: Idx,
    pub exhausted: bool,
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
