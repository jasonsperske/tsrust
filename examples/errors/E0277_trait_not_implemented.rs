// error[E0277]: `Point` doesn't implement `std::fmt::Display`
// `{}` needs Display; derive Debug and use `{:?}` instead, or implement Display.
struct Point { x: i32, y: i32 }

fn main() {
    let p = Point { x: 1, y: 2 };
    println!("{}", p);
}
