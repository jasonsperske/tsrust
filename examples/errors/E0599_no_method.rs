// error[E0599]: no method named `area` found
struct Circle { radius: f64 }

fn main() {
    let c = Circle { radius: 2.0 };
    println!("{}", c.area());
}
