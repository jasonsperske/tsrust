//! Functions that move values around in memory.

/// Move `src` into `*dest` and return the previous value. This is how you get
/// an owned value out from behind a `&mut` without leaving a hole.
pub fn replace<T>(dest: &mut T, src: T) -> T;

/// Swap the values behind two mutable references.
pub fn swap<T>(a: &mut T, b: &mut T);

/// Replace `*dest` with its default value and return the old one.
pub fn take<T: Default>(dest: &mut T) -> T {
    replace(dest, T::default())
}

/// Make the only value of a zero-sized type out of nothing. The caller promises
/// that the type really may be conjured up this way.
pub unsafe fn conjure_zst<T>() -> T;

/// Take ownership of a value without running any cleanup.
pub fn forget<T>(_value: T) {}

/// Take ownership of a value and let it go. The body is empty: ownership
/// moving *into* this function is the whole point.
pub fn drop<T>(_value: T) {}
