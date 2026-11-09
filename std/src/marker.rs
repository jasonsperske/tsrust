//! Marker traits carry no methods; they tell the compiler something about a type.

/// Types whose values can be duplicated by copying bits. Assigning or passing a
/// `Copy` value leaves the original usable; everything else is *moved*.
/// The borrow checker asks "is this type Copy?" at every use of a place.
pub trait Copy: Clone {}
