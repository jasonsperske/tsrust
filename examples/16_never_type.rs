// The never type `!`, stabilized in Rust 1.100, plus some small library
// additions from the same release.
use std::convert::Infallible;
use std::str::FromStr;

// An error type of `!` means this conversion cannot fail...
struct Name(String);

impl FromStr for Name {
    type Err = !;
    fn from_str(s: &str) -> Result<Name, !> {
        Ok(Name(String::from(s.trim_prefix("name:"))))
    }
}

// ...so `Ok(v)` is the only pattern needed, and `let` accepts it.
fn unwrap_infallible<T>(result: Result<T, Infallible>) -> T {
    let Ok(value) = result;
    value
}

// A variant holding `!` can never be built, so `match` may skip it.
enum Step {
    Next(u32),
    #[allow(dead_code)]
    Impossible(!),
}

fn advance(step: Step) -> u32 {
    match step {
        Step::Next(n) => n + 1,
    }
}

// `!` coerces to any type, which is why `return` works as a match arm.
fn parse_or_zero(text: &str) -> i32 {
    let value = match text.parse::<i32>() {
        Ok(n) => n,
        Err(_) => return 0,
    };
    value * 2
}

fn fail(message: &str) -> ! {
    panic!("{}", message)
}

fn checked(n: i32) -> i32 {
    if n >= 0 { n } else { fail("negative") }
}

fn main() {
    let Ok(name) = "name:Ferris".parse::<Name>();
    println!("{}", name.0);

    println!("{}", unwrap_infallible(Ok::<i32, !>(42)));
    println!("{}", advance(Step::Next(1)));
    println!("{} {}", parse_or_zero("21"), parse_or_zero("x"));
    println!("{}", checked(5));

    let nothing: Option<!> = None;
    let values: Vec<!> = Vec::new();
    println!("{:?} {:?}", nothing, values);

    let mut on = false;
    on.toggle();
    println!("{}", on);

    let file = "report.txt";
    println!("{} {}", file.trim_suffix(".txt"), file.trim_suffix(".md"));
}
