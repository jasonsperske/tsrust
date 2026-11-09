// error[E0507]: cannot move out of index
// Taking a `String` out of the vector would leave a hole in it.
fn main() {
    let names = vec![String::from("a"), String::from("b")];
    let first = names[0];
    println!("{}", first);
}
