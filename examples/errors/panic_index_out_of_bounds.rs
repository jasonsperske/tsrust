// This compiles, but panics at runtime: Rust bounds-checks every index.
fn main() {
    let v = vec![1, 2, 3];
    let i = v.len() + 7;
    println!("about to read v[{}]...", i);
    println!("{}", v[i]);
}
