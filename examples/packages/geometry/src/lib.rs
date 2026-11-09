//! A library crate split across several files:
//!   src/lib.rs            (crate root)
//!   src/shapes/mod.rs     (`mod shapes;`)
//!   src/shapes/circle.rs  (`mod circle;` inside shapes)

pub mod shapes;

/// Anything with an area.
pub trait Area {
    fn area(&self) -> f64;
}
