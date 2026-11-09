// Vec, String and HashMap.

use std::collections::HashMap;

fn main() {
    // Word frequency count with the entry API.
    let text = "the quick brown fox jumps over the lazy dog the end";
    let mut counts: HashMap<String, u32> = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word.to_string()).or_insert(0) += 1;
    }
    println!("'the' appears {} times", counts[&String::from("the")]);
    println!("{} distinct words", counts.len());
    match counts.get(&String::from("cat")) {
        Some(n) => println!("cat: {}", n),
        None => println!("no cats"),
    }

    // Vec operations.
    let mut v: Vec<i32> = Vec::new();
    for i in 0..10 {
        if i % 3 != 0 {
            v.push(i * i);
        }
    }
    println!("{:?}", v);
    v.sort();
    v.reverse();
    println!("reversed: {:?}, max = {:?}", v, v.first());
    let removed = v.remove(0);
    println!("removed {}, contains 4? {}", removed, v.contains(&4));

    // Strings: owned and growable.
    let mut s = String::from("Hello");
    s.push(',');
    s.push_str(" world");
    let shout = s.to_uppercase();
    println!("{} ({} bytes) -> {}", s, s.len(), shout);
    for (i, c) in "héllo".chars().enumerate() {
        print!("{}:{} ", i, c);
    }
    println!();
    let csv = "1,2,3,4";
    let mut total = 0;
    for part in csv.split(",") {
        total += part.parse::<i32>().unwrap();
    }
    println!("sum of {} = {}", csv, total);
}
