// Borrowing: many readers (&T) OR one writer (&mut T), never both.
// TSRust's borrow checker uses non-lexical lifetimes (NLL): a borrow ends
// at its last use, not at the end of its scope.

fn push_twice(v: &mut Vec<i32>, x: i32) {
    v.push(x);
    v.push(x);
}

fn sum(v: &Vec<i32>) -> i32 {
    let mut total = 0;
    for x in v {
        total += x;
    }
    total
}

fn main() {
    let mut numbers = vec![1, 2, 3];

    let first = &numbers[0]; // shared borrow...
    println!("first = {}", first); // ...last used here

    push_twice(&mut numbers, 4); // so a mutable borrow is fine now
    println!("{:?}, sum = {}", numbers, sum(&numbers));

    // Two-phase borrows: `numbers.len()` runs before the `&mut` for push.
    numbers.push(numbers.len() as i32);

    // Mutate through a mutable reference.
    for n in &mut numbers {
        *n *= 10;
    }
    println!("{:?}", numbers);

    // Disjoint fields can be borrowed mutably at the same time.
    let mut point = (1, 2);
    let a = &mut point.0;
    let b = &mut point.1;
    *a += 100;
    *b += 200;
    println!("{:?}", point);
}
