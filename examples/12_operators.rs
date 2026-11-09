// Operator overloading through traits like `Add`, plus `Display`.

use std::fmt;
use std::ops::{Add, Mul, Neg};

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vec2 {
    x: f64,
    y: f64,
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, other: Vec2) -> Vec2 {
        Vec2 { x: self.x + other.x, y: self.y + other.y }
    }
}

impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, k: f64) -> Vec2 {
        Vec2 { x: self.x * k, y: self.y * k }
    }
}

impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        Vec2 { x: -self.x, y: -self.y }
    }
}

impl fmt::Display for Vec2 {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "({:.1}, {:.1})", self.x, self.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
struct Money {
    cents: i64,
}

impl Add for Money {
    type Output = Money;
    fn add(self, other: Money) -> Money {
        Money { cents: self.cents + other.cents }
    }
}

fn main() {
    let a = Vec2 { x: 1.0, y: 2.0 };
    let b = Vec2 { x: 0.5, y: -1.0 };
    println!("a + b = {}", a + b);
    println!("a * 3 = {}", a * 3.0);
    println!("-a = {}", -a);
    println!("debug: {:?}, equal? {}", a + b, a + b == Vec2 { x: 1.5, y: 1.0 });

    let price = Money { cents: 1999 };
    let tax = Money { cents: 160 };
    let total = price + tax;
    println!("total: ${}.{}", total.cents / 100, total.cents % 100);
    println!("price < total? {}", price < total);

    let greeting = String::from("Hello, ") + "world";
    println!("{}", greeting);
}
