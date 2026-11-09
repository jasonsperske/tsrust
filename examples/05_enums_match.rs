// Enums carry data, and `match` must handle every case (exhaustiveness).

#[derive(Debug)]
enum Shape {
    Circle(f64),
    Rectangle { width: f64, height: f64 },
    Triangle(f64, f64, f64),
}

fn area(shape: &Shape) -> f64 {
    match shape {
        Shape::Circle(r) => 3.14159 * r * r,
        Shape::Rectangle { width, height } => width * height,
        Shape::Triangle(a, b, c) => {
            // Heron's formula
            let s = (a + b + c) / 2.0;
            (s * (s - a) * (s - b) * (s - c)).sqrt()
        }
    }
}

fn describe(n: i32) -> &'static str {
    match n {
        x if x < 0 => "negative",
        0 => "zero",
        1 | 2 | 3 => "small",
        x if x % 2 == 0 => "big and even",
        _ => "big and odd",
    }
}

fn divide(a: i32, b: i32) -> Option<i32> {
    if b == 0 { None } else { Some(a / b) }
}

fn main() {
    let shapes = vec![
        Shape::Circle(1.0),
        Shape::Rectangle { width: 3.0, height: 4.0 },
        Shape::Triangle(3.0, 4.0, 5.0),
    ];
    for s in &shapes {
        println!("{:?} has area {:.2}", s, area(s));
    }

    for n in vec![-5, 0, 2, 10, 11].iter() {
        println!("{} is {}", n, describe(*n));
    }

    // Option<T> replaces null.
    match divide(10, 2) {
        Some(q) => println!("10 / 2 = {}", q),
        None => println!("division by zero"),
    }
    if let Some(q) = divide(1, 0) {
        println!("unreachable: {}", q);
    } else {
        println!("1 / 0 has no answer");
    }
    println!("{:?} {:?}", divide(9, 3), divide(9, 0).unwrap_or(-1));
}
