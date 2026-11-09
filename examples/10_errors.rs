// Recoverable errors with Result<T, E>, and the `?` operator.

#[derive(Debug)]
enum ParseError {
    Empty,
    NotANumber(String),
    Negative(i64),
}

fn parse_positive(s: &str) -> Result<i64, ParseError> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(ParseError::Empty);
    }
    let n: i64 = match trimmed.parse() {
        Ok(n) => n,
        Err(_) => return Err(ParseError::NotANumber(trimmed.to_string())),
    };
    if n < 0 {
        Err(ParseError::Negative(n))
    } else {
        Ok(n)
    }
}

// `?` returns early with the error, or unwraps the Ok value.
fn sum_all(inputs: &Vec<&str>) -> Result<i64, ParseError> {
    let mut total = 0;
    for s in inputs.iter() {
        total += parse_positive(s)?;
    }
    Ok(total)
}

fn first_even(v: &Vec<i32>) -> Option<i32> {
    for &x in v.iter() {
        if x % 2 == 0 {
            return Some(x);
        }
    }
    None
}

fn first_even_doubled(v: &Vec<i32>) -> Option<i32> {
    let x = first_even(v)?;
    Some(x * 2)
}

fn main() {
    for input in vec!["42", "  7 ", "", "abc", "-3"].iter() {
        match parse_positive(input) {
            Ok(n) => println!("{:?} -> ok {}", input, n),
            Err(e) => println!("{:?} -> error {:?}", input, e),
        }
    }
    println!("{:?}", sum_all(&vec!["1", "2", "3"]));
    println!("{:?}", sum_all(&vec!["1", "oops", "3"]));
    println!("{:?} {:?}", first_even_doubled(&vec![1, 3, 4]), first_even_doubled(&vec![1, 3]));

    let value: i32 = "123".parse().unwrap();
    println!("parsed {}", value + 1);
}
