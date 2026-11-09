// Ownership: every value has exactly one owner. Assigning or passing a
// non-Copy value MOVES it; the old name can no longer be used.

fn take(s: String) -> usize {
    s.len() // `s` is dropped at the end of this function
}

fn borrow(s: &String) -> usize {
    s.len() // only borrowed: the caller keeps ownership
}

fn main() {
    let a = String::from("hello");
    let b = a; // move: `a` is no longer valid
    // println!("{}", a); // ← uncomment: error[E0382]: use of moved value
    println!("b = {}", b);

    let c = b.clone(); // an explicit, deep copy
    println!("taken: {}", take(b));
    println!("borrowed: {}, still usable: {}", borrow(&c), c);

    // Integers are `Copy`: assignment duplicates the bits, nothing moves.
    let n = 5;
    let m = n;
    println!("n = {}, m = {}", n, m);

    // Moving into a function and getting ownership back.
    let s = String::from("round trip");
    let s = give_back(s);
    println!("{}", s);
}

fn give_back(mut s: String) -> String {
    s.push_str("!");
    s
}
