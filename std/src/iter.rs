//! Iterators. A `for` loop is sugar over these traits:
//!
//! ```text
//! for x in expr { body }
//! // becomes
//! let mut iter = IntoIterator::into_iter(expr);
//! loop { match iter.next() { Some(x) => body, None => break } }
//! ```

/// Something that produces a sequence of values, one `next()` at a time.
/// `Item` is an *associated type*: each implementor picks it.
pub trait Iterator {
    type Item;

    fn next(&mut self) -> Option<Self::Item>;

    fn count(mut self) -> usize {
        let mut n = 0;
        while let Some(_) = self.next() {
            n += 1;
        }
        n
    }

    fn last(mut self) -> Option<Self::Item> {
        let mut last = None;
        while let Some(x) = self.next() {
            last = Some(x);
        }
        last
    }

    fn nth(&mut self, n: usize) -> Option<Self::Item> {
        let mut i = 0;
        while let Some(x) = self.next() {
            if i == n {
                return Some(x);
            }
            i += 1;
        }
        None
    }

    fn enumerate(self) -> Enumerate<Self> {
        Enumerate { iter: self, count: 0 }
    }

    fn skip(self, n: usize) -> Skip<Self> {
        Skip { iter: self, n: n }
    }

    fn take(self, n: usize) -> Take<Self> {
        Take { iter: self, n: n }
    }

    fn step_by(self, step: usize) -> StepBy<Self> {
        assert!(step != 0, "step_by: step must be non-zero");
        StepBy { iter: self, step: step - 1, first: true }
    }

    fn zip<U: IntoIterator>(self, other: U) -> Zip<Self, U::IntoIter> {
        Zip { a: self, b: other.into_iter() }
    }

    fn chain<U: IntoIterator<Item = Self::Item>>(self, other: U) -> Chain<Self, U::IntoIter> {
        Chain { a: self, b: other.into_iter(), first_done: false }
    }

    fn sum<S: Sum<Self::Item>>(self) -> S {
        S::sum(self)
    }

    fn product<S: Product<Self::Item>>(self) -> S {
        S::product(self)
    }

    fn collect<B: FromIterator<Self::Item>>(self) -> B {
        B::from_iter(self)
    }
}

/// Conversion into an iterator. `for` loops call this on their argument.
pub trait IntoIterator {
    type Item;
    type IntoIter;
    fn into_iter(self) -> Self::IntoIter;
}

/// Every iterator is trivially convertible into itself.
impl<I: Iterator> IntoIterator for I {
    type Item = I::Item;
    type IntoIter = I;
    fn into_iter(self) -> I {
        self
    }
}

/// Build a collection from an iterator; powers `.collect()`.
pub trait FromIterator<A> {
    fn from_iter<I: Iterator<Item = A>>(iter: I) -> Self;
}

/// Powers `.sum()`.
pub trait Sum<A> {
    fn sum<I: Iterator<Item = A>>(iter: I) -> Self;
}

/// Powers `.product()`.
pub trait Product<A> {
    fn product<I: Iterator<Item = A>>(iter: I) -> Self;
}

pub struct Enumerate<I> {
    iter: I,
    count: usize,
}

impl<I: Iterator> Iterator for Enumerate<I> {
    type Item = (usize, I::Item);
    fn next(&mut self) -> Option<(usize, I::Item)> {
        match self.iter.next() {
            Some(x) => {
                let i = self.count;
                self.count += 1;
                Some((i, x))
            }
            None => None,
        }
    }
}

pub struct Skip<I> {
    iter: I,
    n: usize,
}

impl<I: Iterator> Iterator for Skip<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        while self.n > 0 {
            self.n -= 1;
            if self.iter.next().is_none() {
                return None;
            }
        }
        self.iter.next()
    }
}

pub struct Take<I> {
    iter: I,
    n: usize,
}

impl<I: Iterator> Iterator for Take<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        if self.n == 0 {
            None
        } else {
            self.n -= 1;
            self.iter.next()
        }
    }
}

pub struct StepBy<I> {
    iter: I,
    step: usize,
    first: bool,
}

impl<I: Iterator> Iterator for StepBy<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        if self.first {
            self.first = false;
            self.iter.next()
        } else {
            self.iter.nth(self.step)
        }
    }
}

pub struct Zip<A, B> {
    a: A,
    b: B,
}

impl<A: Iterator, B: Iterator> Iterator for Zip<A, B> {
    type Item = (A::Item, B::Item);
    fn next(&mut self) -> Option<(A::Item, B::Item)> {
        match self.a.next() {
            Some(x) => match self.b.next() {
                Some(y) => Some((x, y)),
                None => None,
            },
            None => None,
        }
    }
}

pub struct Chain<A, B> {
    a: A,
    b: B,
    first_done: bool,
}

impl<A: Iterator, B: Iterator<Item = A::Item>> Iterator for Chain<A, B> {
    type Item = A::Item;
    fn next(&mut self) -> Option<A::Item> {
        if !self.first_done {
            match self.a.next() {
                Some(x) => return Some(x),
                None => self.first_done = true,
            }
        }
        self.b.next()
    }
}

/// Types with a successor, so ranges of them can be iterated. One generic
/// impl per range type (below) lets inference flow: in `for i in 0..n`, the
/// item type is simply the range's element type.
pub trait Step: Copy + PartialOrd {
    fn forward(self) -> Self;
}

impl<A: Step> Iterator for crate::ops::Range<A> {
    type Item = A;
    fn next(&mut self) -> Option<A> {
        if self.start < self.end {
            let value = self.start;
            self.start = self.start.forward();
            Some(value)
        } else {
            None
        }
    }
}

impl<A: Step> Iterator for crate::ops::RangeInclusive<A> {
    type Item = A;
    fn next(&mut self) -> Option<A> {
        if self.exhausted || self.start > self.end {
            None
        } else if self.start == self.end {
            self.exhausted = true;
            Some(self.start)
        } else {
            let value = self.start;
            self.start = self.start.forward();
            Some(value)
        }
    }
}
