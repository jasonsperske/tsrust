// error[E0072]: recursive type has infinite size
// Wrap the recursive field in a Box to give it a fixed size.
enum List {
    Cons(i32, List),
    Nil,
}

fn main() {}
