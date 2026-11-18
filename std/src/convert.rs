//! Conversions between types.

/// Construct `Self` from a `T`.
pub trait From<T> {
    fn from(value: T) -> Self;
}

/// The reciprocal of `From`. Never implement it directly: the blanket impl
/// below gives you `Into<U> for T` for free whenever `U: From<T>`.
pub trait Into<T> {
    fn into(self) -> T;
}

impl<T, U: From<T>> Into<U> for T {
    fn into(self) -> U {
        U::from(self)
    }
}

/// Cheap reference-to-reference conversion.
pub trait AsRef<T: ?Sized> {
    fn as_ref(&self) -> &T;
}

/// Cheap mutable-reference-to-mutable-reference conversion.
pub trait AsMut<T: ?Sized> {
    fn as_mut(&mut self) -> &mut T;
}

impl AsRef<str> for str {
    fn as_ref(&self) -> &str {
        self
    }
}

impl AsRef<str> for crate::string::String {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

impl<'a, T: ?Sized, U: ?Sized + AsRef<T>> AsRef<T> for &'a U {
    fn as_ref(&self) -> &T {
        (**self).as_ref()
    }
}

/// No value of type `!` exists, so these can convert to anything.
impl<T: ?Sized> AsRef<T> for ! {
    fn as_ref(&self) -> &T {
        *self
    }
}

impl<T: ?Sized> AsMut<T> for ! {
    fn as_mut(&mut self) -> &mut T {
        *self
    }
}

/// The error type of conversions that can't fail. Since Rust 1.100 it is just
/// another name for the never type.
pub type Infallible = !;

impl From<&str> for crate::string::String {
    fn from(s: &str) -> crate::string::String {
        crate::string::String::from(s)
    }
}
