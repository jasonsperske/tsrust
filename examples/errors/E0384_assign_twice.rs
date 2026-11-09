// error[E0384]: cannot assign twice to immutable variable
fn main() {
    let x = 5;
    println!("{}", x);
    x = 6;
    println!("{}", x);
}
