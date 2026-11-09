// Lifetimes: the compiler checks that references never outlive the data
// they point to. Signatures say which inputs a returned reference borrows.

// The result borrows from both `x` and `y`, so it's valid only while both are.
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

// Lifetime elision: one input reference, so the output borrows from it.
fn first_word(s: &str) -> &str {
    match s.find(" ") {
        Some(i) => &s[..i],
        None => s,
    }
}

// A struct holding a reference must name its lifetime.
struct Highlight<'a> {
    text: &'a str,
}

impl<'a> Highlight<'a> {
    // Elision: `&self` lends its lifetime to the result.
    fn shout(&self) -> String {
        self.text.to_uppercase()
    }
    fn text(&self) -> &str {
        self.text
    }
}

fn main() {
    let a = String::from("a long string");
    let result;
    {
        let b = String::from("short");
        result = longest(a.as_str(), b.as_str());
        println!("longest: {}", result);
    } // `b` dies here; using `result` after this would be an error (E0597)

    let sentence = String::from("hello wonderful world");
    let word = first_word(&sentence);
    println!("first word: {}", word);

    let h = Highlight { text: &sentence };
    println!("{} / {}", h.text(), h.shout());
}
