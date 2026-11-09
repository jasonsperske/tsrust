// A few classic algorithms.

fn sieve(limit: usize) -> Vec<usize> {
    let mut is_prime = vec![true; limit + 1];
    is_prime[0] = false;
    if limit >= 1 {
        is_prime[1] = false;
    }
    let mut i = 2;
    while i * i <= limit {
        if is_prime[i] {
            let mut j = i * i;
            while j <= limit {
                is_prime[j] = false;
                j += i;
            }
        }
        i += 1;
    }
    let mut primes = Vec::new();
    for (n, &p) in is_prime.iter().enumerate() {
        if p {
            primes.push(n);
        }
    }
    primes
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

fn bubble_sort(v: &mut Vec<i32>) {
    let n = v.len();
    for i in 0..n {
        for j in 0..n - 1 - i {
            if v[j] > v[j + 1] {
                v.swap(j, j + 1);
            }
        }
    }
}

fn binary_search(v: &Vec<i32>, target: i32) -> Option<usize> {
    let mut lo = 0;
    let mut hi = v.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if v[mid] == target {
            return Some(mid);
        } else if v[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    None
}

fn fizzbuzz(n: u32) -> String {
    match (n % 3, n % 5) {
        (0, 0) => String::from("FizzBuzz"),
        (0, _) => String::from("Fizz"),
        (_, 0) => String::from("Buzz"),
        _ => n.to_string(),
    }
}

fn main() {
    println!("primes: {:?}", sieve(50));
    println!("gcd(1071, 462) = {}", gcd(1071, 462));

    let mut v = vec![5, 2, 9, 1, 5, 6];
    bubble_sort(&mut v);
    println!("sorted: {:?}", v);
    println!("find 6: {:?}, find 3: {:?}", binary_search(&v, 6), binary_search(&v, 3));

    let mut line = String::new();
    for n in 1..=15 {
        line.push_str(&fizzbuzz(n));
        line.push(' ');
    }
    println!("{}", line.trim());
}
