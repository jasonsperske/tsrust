// Traits describe shared behavior; generics with trait bounds let one
// function work for many types. TSRust *monomorphizes*: `largest::<i32>`
// and `largest::<char>` become two separate compiled functions.

use std::fmt;

trait Shape {
    fn area(&self) -> f64;
    fn name(&self) -> String;

    // A default method, available to every implementor.
    fn describe(&self) -> String {
        format!("{} with area {:.1}", self.name(), self.area())
    }
}

struct Square(f64);
struct Circle(f64);

impl Shape for Square {
    fn area(&self) -> f64 { self.0 * self.0 }
    fn name(&self) -> String { String::from("square") }
}

impl Shape for Circle {
    fn area(&self) -> f64 { 3.14159 * self.0 * self.0 }
    fn name(&self) -> String { String::from("circle") }
    fn describe(&self) -> String { format!("a round circle of radius {}", self.0) }
}

// A generic function with a trait bound.
fn print_shape<S: Shape>(shape: &S) {
    println!("{}", shape.describe());
}

// Multiple bounds, with a `where` clause.
fn largest<T>(items: &Vec<T>) -> T
where
    T: PartialOrd + Copy,
{
    let mut best = items[0];
    for &item in items.iter() {
        if item > best {
            best = item;
        }
    }
    best
}

// A generic struct.
#[derive(Debug)]
struct Pair<T> {
    a: T,
    b: T,
}

impl<T: PartialOrd + fmt::Display> Pair<T> {
    fn print_larger(&self) {
        if self.a >= self.b {
            println!("larger is a = {}", self.a);
        } else {
            println!("larger is b = {}", self.b);
        }
    }
}

// Implementing a standard library trait.
impl fmt::Display for Square {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Square({})", self.0)
    }
}

fn main() {
    print_shape(&Square(2.0));
    print_shape(&Circle(1.0));

    println!("largest i32: {}", largest(&vec![34, 50, 25, 100, 65]));
    println!("largest char: {}", largest(&vec!['y', 'm', 'a', 'q']));

    let p = Pair { a: 5, b: 10 };
    p.print_larger();
    println!("{:?}", p);

    let sq = Square(3.0);
    println!("displayed: {}, as string: {}", sq, sq.to_string());
}
