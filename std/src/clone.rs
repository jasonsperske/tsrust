/// Explicit duplication. Unlike `Copy`, a clone may do real work (like
/// allocating a new `String`).
pub trait Clone {
    fn clone(&self) -> Self;
}
