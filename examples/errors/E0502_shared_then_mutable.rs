// error[E0502]: cannot borrow as mutable because it is also borrowed as immutable
// `push` may reallocate the vector, which would leave `first` dangling.
fn main() {
    let mut v = vec![1, 2, 3];
    let first = &v[0];
    v.push(4);
    println!("first is {}", first);
}
