//! `Box<T>`: a value on the heap with a single owner.
//!
//! The type checker knows `Box` is special: `*b` dereferences it and method
//! calls auto-deref through it, just like references. Recursive types such as
//! `enum List { Cons(i32, Box<List>), Nil }` need the indirection to have a
//! finite size.

pub struct Box<T>;

impl<T> Box<T> {
    pub fn new(value: T) -> Box<T>;
}

impl<T: Clone> Clone for Box<T> {
    fn clone(&self) -> Box<T> {
        Box::new((**self).clone())
    }
}

/// `{}` on a box formats what's inside, using the inner type's own `Display`.
impl<T: crate::fmt::Display> crate::fmt::Display for Box<T> {
    fn fmt(&self, f: &mut crate::fmt::Formatter) -> crate::fmt::Result {
        (**self).fmt(f)
    }
}
