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

    fn map<B, F: FnMut(Self::Item) -> B>(self, f: F) -> Map<Self, F> {
        Map { iter: self, f: f }
    }

    fn filter<P: FnMut(&Self::Item) -> bool>(self, predicate: P) -> Filter<Self, P> {
        Filter { iter: self, predicate: predicate }
    }

    fn filter_map<B, F: FnMut(Self::Item) -> Option<B>>(self, f: F) -> FilterMap<Self, F> {
        FilterMap { iter: self, f: f }
    }

    fn flat_map<U: IntoIterator, F: FnMut(Self::Item) -> U>(self, f: F) -> FlatMap<Self, U, F>
    where
        U::IntoIter: Iterator<Item = U::Item>,
    {
        FlatMap { iter: self, f: f, current: None }
    }

    fn flatten(self) -> Flatten<Self, Self::Item>
    where
        Self::Item: IntoIterator,
    {
        Flatten { iter: self, current: None }
    }

    fn take_while<P: FnMut(&Self::Item) -> bool>(self, predicate: P) -> TakeWhile<Self, P> {
        TakeWhile { iter: self, predicate: predicate, done: false }
    }

    fn skip_while<P: FnMut(&Self::Item) -> bool>(self, predicate: P) -> SkipWhile<Self, P> {
        SkipWhile { iter: self, predicate: predicate, started: false }
    }

    fn map_while<B, P: FnMut(Self::Item) -> Option<B>>(self, predicate: P) -> MapWhile<Self, P> {
        MapWhile { iter: self, predicate: predicate }
    }

    fn inspect<F: FnMut(&Self::Item)>(self, f: F) -> Inspect<Self, F> {
        Inspect { iter: self, f: f }
    }

    fn scan<St, B, F: FnMut(&mut St, Self::Item) -> Option<B>>(self, state: St, f: F) -> Scan<Self, St, F> {
        Scan { iter: self, state: state, f: f }
    }

    fn peekable(self) -> Peekable<Self> {
        Peekable { iter: self, peeked: None }
    }

    fn rev(self) -> Rev<Self>
    where
        Self: DoubleEndedIterator,
    {
        Rev { iter: self }
    }

    fn cycle(self) -> Cycle<Self>
    where
        Self: Clone,
    {
        Cycle { original: self.clone(), iter: self }
    }

    fn cloned<'a, T: Clone + 'a>(self) -> Cloned<Self>
    where
        Self: Iterator<Item = &'a T>,
    {
        Cloned { iter: self }
    }

    fn copied<'a, T: Copy + 'a>(self) -> Copied<Self>
    where
        Self: Iterator<Item = &'a T>,
    {
        Copied { iter: self }
    }

    fn by_ref(&mut self) -> &mut Self {
        self
    }

    fn for_each<F: FnMut(Self::Item)>(mut self, mut f: F) {
        while let Some(x) = self.next() {
            f(x);
        }
    }

    fn fold<B, F: FnMut(B, Self::Item) -> B>(mut self, init: B, mut f: F) -> B {
        let mut acc = init;
        while let Some(x) = self.next() {
            acc = f(acc, x);
        }
        acc
    }

    fn reduce<F: FnMut(Self::Item, Self::Item) -> Self::Item>(mut self, mut f: F) -> Option<Self::Item> {
        let mut acc = self.next()?;
        while let Some(x) = self.next() {
            acc = f(acc, x);
        }
        Some(acc)
    }

    fn all<F: FnMut(Self::Item) -> bool>(&mut self, mut f: F) -> bool {
        while let Some(x) = self.next() {
            if !f(x) {
                return false;
            }
        }
        true
    }

    fn any<F: FnMut(Self::Item) -> bool>(&mut self, mut f: F) -> bool {
        while let Some(x) = self.next() {
            if f(x) {
                return true;
            }
        }
        false
    }

    fn find<P: FnMut(&Self::Item) -> bool>(&mut self, mut predicate: P) -> Option<Self::Item> {
        while let Some(x) = self.next() {
            if predicate(&x) {
                return Some(x);
            }
        }
        None
    }

    fn find_map<B, F: FnMut(Self::Item) -> Option<B>>(&mut self, mut f: F) -> Option<B> {
        while let Some(x) = self.next() {
            if let Some(b) = f(x) {
                return Some(b);
            }
        }
        None
    }

    fn position<P: FnMut(Self::Item) -> bool>(&mut self, mut predicate: P) -> Option<usize> {
        let mut i = 0;
        while let Some(x) = self.next() {
            if predicate(x) {
                return Some(i);
            }
            i += 1;
        }
        None
    }

    fn max(self) -> Option<Self::Item>
    where
        Self::Item: Ord,
    {
        self.max_by(|a, b| a.cmp(b))
    }

    fn min(self) -> Option<Self::Item>
    where
        Self::Item: Ord,
    {
        self.min_by(|a, b| a.cmp(b))
    }

    /// On ties, the last maximum wins.
    fn max_by<F: FnMut(&Self::Item, &Self::Item) -> crate::cmp::Ordering>(mut self, mut compare: F) -> Option<Self::Item> {
        let mut best = self.next()?;
        while let Some(x) = self.next() {
            if compare(&best, &x) != crate::cmp::Ordering::Greater {
                best = x;
            }
        }
        Some(best)
    }

    /// On ties, the first minimum wins.
    fn min_by<F: FnMut(&Self::Item, &Self::Item) -> crate::cmp::Ordering>(mut self, mut compare: F) -> Option<Self::Item> {
        let mut best = self.next()?;
        while let Some(x) = self.next() {
            if compare(&best, &x) == crate::cmp::Ordering::Greater {
                best = x;
            }
        }
        Some(best)
    }

    fn max_by_key<B: Ord, F: FnMut(&Self::Item) -> B>(self, mut f: F) -> Option<Self::Item> {
        self.max_by(|a, b| f(a).cmp(&f(b)))
    }

    fn min_by_key<B: Ord, F: FnMut(&Self::Item) -> B>(self, mut f: F) -> Option<Self::Item> {
        self.min_by(|a, b| f(a).cmp(&f(b)))
    }

    fn partition<B: Default + Extend<Self::Item>, F: FnMut(&Self::Item) -> bool>(mut self, mut f: F) -> (B, B) {
        let mut yes = B::default();
        let mut no = B::default();
        while let Some(x) = self.next() {
            if f(&x) {
                yes.extend_one(x);
            } else {
                no.extend_one(x);
            }
        }
        (yes, no)
    }

    fn unzip<A, B, X: Default + Extend<A>, Y: Default + Extend<B>>(mut self) -> (X, Y)
    where
        Self: Iterator<Item = (A, B)>,
    {
        let mut xs = X::default();
        let mut ys = Y::default();
        while let Some((a, b)) = self.next() {
            xs.extend_one(a);
            ys.extend_one(b);
        }
        (xs, ys)
    }
}

/// Collections that can grow one element at a time.
pub trait Extend<A> {
    fn extend_one(&mut self, item: A);
}

/// An iterator that can also produce items from its far end.
pub trait DoubleEndedIterator: Iterator {
    fn next_back(&mut self) -> Option<Self::Item>;
}

/// An iterator that knows exactly how many items remain.
pub trait ExactSizeIterator: Iterator {
    fn len(&self) -> usize;
}

impl<'a, I: Iterator> Iterator for &'a mut I {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        (**self).next()
    }
}

#[derive(Clone)]
pub struct Map<I, F> {
    iter: I,
    f: F,
}

impl<B, I: Iterator, F: FnMut(I::Item) -> B> Iterator for Map<I, F> {
    type Item = B;
    fn next(&mut self) -> Option<B> {
        match self.iter.next() {
            Some(x) => Some((self.f)(x)),
            None => None,
        }
    }
}

impl<B, I: DoubleEndedIterator, F: FnMut(I::Item) -> B> DoubleEndedIterator for Map<I, F> {
    fn next_back(&mut self) -> Option<B> {
        match self.iter.next_back() {
            Some(x) => Some((self.f)(x)),
            None => None,
        }
    }
}

impl<B, I: ExactSizeIterator, F: FnMut(I::Item) -> B> ExactSizeIterator for Map<I, F> {
    fn len(&self) -> usize {
        self.iter.len()
    }
}

#[derive(Clone)]
pub struct Filter<I, P> {
    iter: I,
    predicate: P,
}

impl<I: Iterator, P: FnMut(&I::Item) -> bool> Iterator for Filter<I, P> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        while let Some(x) = self.iter.next() {
            if (self.predicate)(&x) {
                return Some(x);
            }
        }
        None
    }
}

impl<I: DoubleEndedIterator, P: FnMut(&I::Item) -> bool> DoubleEndedIterator for Filter<I, P> {
    fn next_back(&mut self) -> Option<I::Item> {
        while let Some(x) = self.iter.next_back() {
            if (self.predicate)(&x) {
                return Some(x);
            }
        }
        None
    }
}

#[derive(Clone)]
pub struct FilterMap<I, F> {
    iter: I,
    f: F,
}

impl<B, I: Iterator, F: FnMut(I::Item) -> Option<B>> Iterator for FilterMap<I, F> {
    type Item = B;
    fn next(&mut self) -> Option<B> {
        while let Some(x) = self.iter.next() {
            if let Some(y) = (self.f)(x) {
                return Some(y);
            }
        }
        None
    }
}

pub struct FlatMap<I, U: IntoIterator, F> {
    iter: I,
    f: F,
    current: Option<U::IntoIter>,
}

impl<I: Iterator, U: IntoIterator, F: FnMut(I::Item) -> U> Iterator for FlatMap<I, U, F>
where
    U::IntoIter: Iterator<Item = U::Item>,
{
    type Item = U::Item;
    fn next(&mut self) -> Option<U::Item> {
        loop {
            if let Some(inner) = &mut self.current {
                if let Some(x) = inner.next() {
                    return Some(x);
                }
            }
            match self.iter.next() {
                Some(x) => self.current = Some((self.f)(x).into_iter()),
                None => return None,
            }
        }
    }
}

pub struct Flatten<I, U: IntoIterator> {
    iter: I,
    current: Option<U::IntoIter>,
}

impl<U: IntoIterator, I: Iterator<Item = U>> Iterator for Flatten<I, U>
where
    U::IntoIter: Iterator<Item = U::Item>,
{
    type Item = U::Item;
    fn next(&mut self) -> Option<U::Item> {
        loop {
            if let Some(inner) = &mut self.current {
                if let Some(x) = inner.next() {
                    return Some(x);
                }
            }
            match self.iter.next() {
                Some(x) => self.current = Some(x.into_iter()),
                None => return None,
            }
        }
    }
}

#[derive(Clone)]
pub struct TakeWhile<I, P> {
    iter: I,
    predicate: P,
    done: bool,
}

impl<I: Iterator, P: FnMut(&I::Item) -> bool> Iterator for TakeWhile<I, P> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        if self.done {
            return None;
        }
        let x = self.iter.next()?;
        if (self.predicate)(&x) {
            Some(x)
        } else {
            self.done = true;
            None
        }
    }
}

#[derive(Clone)]
pub struct SkipWhile<I, P> {
    iter: I,
    predicate: P,
    started: bool,
}

impl<I: Iterator, P: FnMut(&I::Item) -> bool> Iterator for SkipWhile<I, P> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        while let Some(x) = self.iter.next() {
            if self.started || !(self.predicate)(&x) {
                self.started = true;
                return Some(x);
            }
        }
        None
    }
}

#[derive(Clone)]
pub struct MapWhile<I, P> {
    iter: I,
    predicate: P,
}

impl<B, I: Iterator, P: FnMut(I::Item) -> Option<B>> Iterator for MapWhile<I, P> {
    type Item = B;
    fn next(&mut self) -> Option<B> {
        let x = self.iter.next()?;
        (self.predicate)(x)
    }
}

#[derive(Clone)]
pub struct Inspect<I, F> {
    iter: I,
    f: F,
}

impl<I: Iterator, F: FnMut(&I::Item)> Iterator for Inspect<I, F> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        let x = self.iter.next()?;
        (self.f)(&x);
        Some(x)
    }
}

#[derive(Clone)]
pub struct Scan<I, St, F> {
    iter: I,
    state: St,
    f: F,
}

impl<B, I: Iterator, St, F: FnMut(&mut St, I::Item) -> Option<B>> Iterator for Scan<I, St, F> {
    type Item = B;
    fn next(&mut self) -> Option<B> {
        let x = self.iter.next()?;
        (self.f)(&mut self.state, x)
    }
}

pub struct Peekable<I: Iterator> {
    iter: I,
    peeked: Option<Option<I::Item>>,
}

impl<I: Iterator> Peekable<I> {
    pub fn peek(&mut self) -> Option<&I::Item> {
        if self.peeked.is_none() {
            self.peeked = Some(self.iter.next());
        }
        match &self.peeked {
            Some(Some(x)) => Some(x),
            _ => None,
        }
    }

    pub fn next_if<F: FnOnce(&I::Item) -> bool>(&mut self, f: F) -> Option<I::Item> {
        let ok = match self.peek() {
            Some(x) => f(x),
            None => false,
        };
        if ok { self.next() } else { None }
    }
}

impl<I: Iterator> Iterator for Peekable<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        match self.peeked.take() {
            Some(x) => x,
            None => self.iter.next(),
        }
    }
}

#[derive(Clone)]
pub struct Rev<I> {
    iter: I,
}

impl<I: DoubleEndedIterator> Iterator for Rev<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        self.iter.next_back()
    }
}

impl<I: DoubleEndedIterator> DoubleEndedIterator for Rev<I> {
    fn next_back(&mut self) -> Option<I::Item> {
        self.iter.next()
    }
}

impl<I: ExactSizeIterator + DoubleEndedIterator> ExactSizeIterator for Rev<I> {
    fn len(&self) -> usize {
        self.iter.len()
    }
}

#[derive(Clone)]
pub struct Cycle<I> {
    original: I,
    iter: I,
}

impl<I: Iterator + Clone> Iterator for Cycle<I> {
    type Item = I::Item;
    fn next(&mut self) -> Option<I::Item> {
        match self.iter.next() {
            Some(x) => Some(x),
            None => {
                self.iter = self.original.clone();
                self.iter.next()
            }
        }
    }
}

#[derive(Clone)]
pub struct Cloned<I> {
    iter: I,
}

impl<'a, T: Clone + 'a, I: Iterator<Item = &'a T>> Iterator for Cloned<I> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        match self.iter.next() {
            Some(x) => Some(x.clone()),
            None => None,
        }
    }
}

impl<'a, T: Clone + 'a, I: DoubleEndedIterator<Item = &'a T>> DoubleEndedIterator for Cloned<I> {
    fn next_back(&mut self) -> Option<T> {
        match self.iter.next_back() {
            Some(x) => Some(x.clone()),
            None => None,
        }
    }
}

#[derive(Clone)]
pub struct Copied<I> {
    iter: I,
}

impl<'a, T: Copy + 'a, I: Iterator<Item = &'a T>> Iterator for Copied<I> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        match self.iter.next() {
            Some(x) => Some(*x),
            None => None,
        }
    }
}

impl<'a, T: Copy + 'a, I: DoubleEndedIterator<Item = &'a T>> DoubleEndedIterator for Copied<I> {
    fn next_back(&mut self) -> Option<T> {
        match self.iter.next_back() {
            Some(x) => Some(*x),
            None => None,
        }
    }
}

impl<I: ExactSizeIterator + DoubleEndedIterator> DoubleEndedIterator for Enumerate<I> {
    fn next_back(&mut self) -> Option<(usize, I::Item)> {
        let n = self.iter.len();
        match self.iter.next_back() {
            Some(x) => Some((self.count + n - 1, x)),
            None => None,
        }
    }
}

impl<I: ExactSizeIterator> ExactSizeIterator for Enumerate<I> {
    fn len(&self) -> usize {
        self.iter.len()
    }
}

impl<A: Step> DoubleEndedIterator for crate::ops::Range<A> {
    fn next_back(&mut self) -> Option<A> {
        if self.start < self.end {
            self.end = self.end.backward();
            Some(self.end)
        } else {
            None
        }
    }
}

impl<A: Step> ExactSizeIterator for crate::ops::Range<A> {
    fn len(&self) -> usize {
        if self.start < self.end { A::steps_between(self.start, self.end) } else { 0 }
    }
}

impl<A: Step> DoubleEndedIterator for crate::ops::RangeInclusive<A> {
    fn next_back(&mut self) -> Option<A> {
        if self.exhausted || self.start > self.end {
            None
        } else if self.start == self.end {
            self.exhausted = true;
            Some(self.end)
        } else {
            let value = self.end;
            self.end = self.end.backward();
            Some(value)
        }
    }
}

impl<A: Step> Iterator for crate::ops::RangeFrom<A> {
    type Item = A;
    fn next(&mut self) -> Option<A> {
        let value = self.start;
        self.start = self.start.forward();
        Some(value)
    }
}

/// Repeatedly call `f`.
pub fn from_fn<T, F: FnMut() -> Option<T>>(f: F) -> FromFn<F> {
    FromFn { f: f }
}

#[derive(Clone)]
pub struct FromFn<F> {
    f: F,
}

impl<T, F: FnMut() -> Option<T>> Iterator for FromFn<F> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        (self.f)()
    }
}

pub fn repeat<T: Clone>(value: T) -> Repeat<T> {
    Repeat { value: value }
}

#[derive(Clone)]
pub struct Repeat<T> {
    value: T,
}

impl<T: Clone> Iterator for Repeat<T> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        Some(self.value.clone())
    }
}

pub fn once<T>(value: T) -> crate::option::IntoIter<T> {
    Some(value).into_iter()
}

pub fn successors<T, F: FnMut(&T) -> Option<T>>(first: Option<T>, succ: F) -> Successors<T, F> {
    Successors { next: first, succ: succ }
}

#[derive(Clone)]
pub struct Successors<T, F> {
    next: Option<T>,
    succ: F,
}

impl<T, F: FnMut(&T) -> Option<T>> Iterator for Successors<T, F> {
    type Item = T;
    fn next(&mut self) -> Option<T> {
        let item = self.next.take()?;
        self.next = (self.succ)(&item);
        Some(item)
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

#[derive(Clone)]
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

#[derive(Clone)]
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

#[derive(Clone)]
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

#[derive(Clone)]
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

#[derive(Clone)]
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

#[derive(Clone)]
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
    fn backward(self) -> Self;
    fn steps_between(start: Self, end: Self) -> usize;
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
