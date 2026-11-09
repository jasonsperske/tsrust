// Iterators: implement `next`, get `enumerate`, `zip`, `sum`, `collect`...
// `for` loops are sugar for calling `IntoIterator::into_iter` and `next`.

struct Countdown {
    remaining: u32,
}

impl Iterator for Countdown {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        if self.remaining == 0 {
            None
        } else {
            self.remaining -= 1;
            Some(self.remaining + 1)
        }
    }
}

struct Fibonacci {
    a: u64,
    b: u64,
}

impl Iterator for Fibonacci {
    type Item = u64;
    fn next(&mut self) -> Option<u64> {
        let current = self.a;
        self.a = self.b;
        self.b = current + self.b;
        Some(current)
    }
}

fn main() {
    for n in (Countdown { remaining: 3 }) {
        println!("{}...", n);
    }
    println!("liftoff!");

    let fibs: Vec<u64> = Fibonacci { a: 0, b: 1 }.take(10).collect();
    println!("fib: {:?}", fibs);

    let total: u32 = Countdown { remaining: 100 }.sum();
    println!("1 + 2 + ... + 100 = {}", total);

    let names = vec!["ada", "grace", "barbara"];
    for (i, name) in names.iter().enumerate() {
        println!("{}: {}", i, name);
    }

    let squares: Vec<i32> = (1..=5).collect();
    let evens: Vec<i32> = (0..20).step_by(5).collect();
    println!("{:?} {:?}", squares, evens);

    for (a, b) in names.iter().zip(squares.iter()) {
        println!("{} -> {}", a, b);
    }

    let word: String = "hello".chars().skip(1).collect();
    println!("{} has {} chars", word, word.chars().count());
}
