// Structs, impl blocks, methods and associated functions.

#[derive(Debug, Clone, Copy, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    // An associated function (no `self`): called as `Point::new(..)`.
    fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn origin() -> Self {
        Self { x: 0.0, y: 0.0 }
    }

    // `&self`: borrows the point immutably.
    fn distance(&self, other: &Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }

    // `&mut self`: borrows mutably.
    fn translate(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
    }
}

#[derive(Debug)]
struct Rectangle {
    top_left: Point,
    width: f64,
    height: f64,
}

impl Rectangle {
    fn area(&self) -> f64 {
        self.width * self.height
    }

    fn contains(&self, p: &Point) -> bool {
        p.x >= self.top_left.x
            && p.x <= self.top_left.x + self.width
            && p.y >= self.top_left.y
            && p.y <= self.top_left.y + self.height
    }
}

// A tuple struct ("newtype").
struct Meters(f64);

fn main() {
    let mut p = Point::new(3.0, 4.0);
    println!("{:?} is {} from the origin", p, p.distance(&Point::origin()));

    let q = p; // Point is Copy, so `p` is still usable
    p.translate(1.0, 1.0);
    println!("p = {:?}, q = {:?}, equal? {}", p, q, p == q);

    let r = Rectangle { top_left: Point::origin(), width: 10.0, height: 5.0 };
    println!("area = {}", r.area());
    println!("contains p? {}", r.contains(&p));
    println!("{:#?}", r);

    let m = Meters(42.5);
    println!("{} meters", m.0);
}
