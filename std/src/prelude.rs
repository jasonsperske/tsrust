//! Names every module can use without importing them.

pub use crate::boxed::Box;
pub use crate::clone::Clone;
pub use crate::cmp::{Eq, Ord, PartialEq, PartialOrd};
pub use crate::convert::{AsMut, AsRef, From, Into};
pub use crate::default::Default;
pub use crate::iter::{DoubleEndedIterator, ExactSizeIterator, Extend, IntoIterator, Iterator};
pub use crate::ops::{Fn, FnMut, FnOnce};
pub use crate::marker::Copy;
pub use crate::mem::drop;
pub use crate::option::Option::{self, None, Some};
pub use crate::result::Result::{self, Err, Ok};
pub use crate::string::{String, ToString};
pub use crate::vec::Vec;
