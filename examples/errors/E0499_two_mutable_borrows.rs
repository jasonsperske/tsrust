// error[E0499]: cannot borrow as mutable more than once at a time
// Two live `&mut` to the same data would let them race each other.
fn main() {
    let mut scores = vec![10, 20];
    let a = &mut scores;
    let b = &mut scores;
    a.push(30);
    b.push(40);
}
