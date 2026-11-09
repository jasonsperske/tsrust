// error[E0308]: mismatched types
// Rust never converts between types implicitly.
fn double(x: i32) -> i32 {
    x * 2
}

fn main() {
    let n: i64 = 21;
    println!("{}", double(n));
}
