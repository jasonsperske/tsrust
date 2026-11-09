// error[E0106]: missing lifetime specifier
// Does the result borrow from `x` or from `y`? The signature must say.
fn longest(x: &str, y: &str) -> &str {
    if x.len() > y.len() { x } else { y }
}

fn main() {
    println!("{}", longest("a", "bb"));
}
