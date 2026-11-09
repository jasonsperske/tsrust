// Modules organize code and control privacy. Items are private by default;
// `pub` makes them visible outside their module.

mod geometry {
    pub mod shapes {
        #[derive(Debug)]
        pub struct Rect {
            pub width: u32,
            pub height: u32,
            id: u32, // private field
        }

        impl Rect {
            pub fn new(width: u32, height: u32) -> Rect {
                Rect { width, height, id: next_id() }
            }
            pub fn id(&self) -> u32 {
                self.id
            }
        }

        fn next_id() -> u32 {
            7 // private helper, visible only inside `shapes`
        }
    }

    pub fn area(r: &shapes::Rect) -> u32 {
        r.width * r.height
    }

    pub use self::shapes::Rect;
}

mod math {
    pub const SCALE: i32 = 10;

    pub fn scaled(x: i32) -> i32 {
        x * SCALE + super::offset()
    }
}

fn offset() -> i32 {
    1
}

use geometry::{area, Rect};

fn main() {
    let r = Rect::new(3, 4);
    println!("{:?}", r);
    println!("area = {}, id = {}", area(&r), r.id());
    println!("scaled = {}", math::scaled(5));
    println!("SCALE = {}", math::SCALE);
    // r.id  ← private field: error[E0616]
}
