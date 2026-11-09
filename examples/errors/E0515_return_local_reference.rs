// error[E0515]: cannot return reference to local variable
// `s` is dropped when the function returns; the reference would dangle.
fn make_greeting<'a>(name: &'a str) -> &'a str {
    let s = format!("Hello, {}", name);
    &s
}

fn main() {
    println!("{}", make_greeting("you"));
}
