// Integer overflow is checked: in debug builds Rust panics instead of wrapping.
fn main() {
    let mut x: u8 = 250;
    for _ in 0..10 {
        x += 1;
        println!("x = {}", x);
    }
}
