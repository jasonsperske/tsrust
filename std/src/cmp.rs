//! Comparison traits. `a == b` calls `PartialEq::eq`, and `a < b` calls
//! `PartialOrd::lt`. Primitive types implement these directly in the VM.

/// The result of comparing two values.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Ordering {
    Less,
    Equal,
    Greater,
}

impl Ordering {
    pub fn is_lt(self) -> bool { self == Ordering::Less }
    pub fn is_eq(self) -> bool { self == Ordering::Equal }
    pub fn is_gt(self) -> bool { self == Ordering::Greater }
    pub fn is_le(self) -> bool { self != Ordering::Greater }
    pub fn is_ge(self) -> bool { self != Ordering::Less }
    pub fn reverse(self) -> Ordering {
        match self {
            Ordering::Less => Ordering::Greater,
            Ordering::Equal => Ordering::Equal,
            Ordering::Greater => Ordering::Less,
        }
    }
}

pub trait PartialEq {
    fn eq(&self, other: &Self) -> bool;
    fn ne(&self, other: &Self) -> bool {
        !self.eq(other)
    }
}

/// Equality that is reflexive (`a == a` always holds). A pure marker.
pub trait Eq: PartialEq {}

pub trait PartialOrd: PartialEq {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering>;
    fn lt(&self, other: &Self) -> bool {
        match self.partial_cmp(other) { Some(Ordering::Less) => true, _ => false }
    }
    fn le(&self, other: &Self) -> bool {
        match self.partial_cmp(other) { Some(Ordering::Less) | Some(Ordering::Equal) => true, _ => false }
    }
    fn gt(&self, other: &Self) -> bool {
        match self.partial_cmp(other) { Some(Ordering::Greater) => true, _ => false }
    }
    fn ge(&self, other: &Self) -> bool {
        match self.partial_cmp(other) { Some(Ordering::Greater) | Some(Ordering::Equal) => true, _ => false }
    }
}

pub trait Ord: Eq + PartialOrd {
    fn cmp(&self, other: &Self) -> Ordering;
    fn max(self, other: Self) -> Self {
        if other.cmp(&self) == Ordering::Less { self } else { other }
    }
    fn min(self, other: Self) -> Self {
        if other.cmp(&self) == Ordering::Less { other } else { self }
    }
    fn clamp(self, min: Self, max: Self) -> Self {
        if self.cmp(&min) == Ordering::Less {
            min
        } else if self.cmp(&max) == Ordering::Greater {
            max
        } else {
            self
        }
    }
}

pub fn max<T: Ord>(a: T, b: T) -> T { a.max(b) }
pub fn min<T: Ord>(a: T, b: T) -> T { a.min(b) }
