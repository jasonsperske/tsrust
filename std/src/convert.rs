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

impl From<&str> for crate::string::String {
    fn from(s: &str) -> crate::string::String {
        crate::string::String::from(s)
    }
}
