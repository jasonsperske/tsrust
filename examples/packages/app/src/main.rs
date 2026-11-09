// A binary crate that depends on two library crates. The package graph is:
//
//   app ──> geometry ──> util
//    └──────────────────> util      (a "diamond": util is built once)
//
// Each crate also implicitly depends on `std`.

use geometry::shapes::{Circle, Square};
use geometry::Area;
use util::banner;

fn main() {
    println!("{}", banner("shapes"));
    let shapes_total = Circle::new(1.0).area() + Square::new(2.0).area();
    println!("total area: {:.3}", shapes_total);
    println!("{}", util::stars(3));
}
