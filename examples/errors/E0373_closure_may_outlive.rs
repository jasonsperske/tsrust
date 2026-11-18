fn make() -> impl Fn() -> i32 {
    let x = 1;
    || x
}

fn main() {
    println!("{}", make()());
}
