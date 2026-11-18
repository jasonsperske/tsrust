// Closures capture what they use: by reference, by mutable reference, or by
// value. The compiler works out which from the closure's body.

fn apply_twice<F: Fn(i32) -> i32>(f: F, x: i32) -> i32 {
    f(f(x))
}

fn call_n(n: u32, mut f: impl FnMut()) {
    for _ in 0..n {
        f();
    }
}

fn consume<F: FnOnce() -> String>(f: F) -> String {
    f()
}

// Returning a closure: `move` makes it own `n`.
fn adder(n: i32) -> impl Fn(i32) -> i32 {
    move |x| x + n
}

fn counter() -> impl FnMut() -> u32 {
    let mut count = 0;
    move || {
        count += 1;
        count
    }
}

fn compose<A, B, C>(f: impl Fn(A) -> B, g: impl Fn(B) -> C) -> impl Fn(A) -> C {
    move |x| g(f(x))
}

fn double(x: i32) -> i32 {
    x * 2
}

struct Button<F> {
    label: String,
    on_click: F,
}

impl<F: FnMut(&str)> Button<F> {
    fn click(&mut self) {
        (self.on_click)(&self.label);
    }
}

#[derive(Debug)]
struct Item {
    name: String,
    price: u32,
}

fn main() {
    let offset = 10;
    println!("{}", apply_twice(|x| x + offset, 1));

    let mut total = 0;
    call_n(3, || total += 2);
    println!("{}", total);

    let name = String::from("Ferris");
    println!("{}", consume(move || name + "!"));

    println!("{}", adder(5)(1));
    let mut next = counter();
    next();
    println!("{}", next());
    println!("{}", compose(double, |n: i32| format!("<{}>", n))(4));

    // Functions and constructors can be used wherever a closure can.
    let table: [fn(i32) -> i32; 2] = [double, |x| x - 1];
    println!("{:?}", table.iter().map(|f| f(10)).collect::<Vec<_>>());
    println!("{:?}", vec![1, 2].into_iter().map(Some).collect::<Vec<_>>());

    let mut log = Vec::new();
    let mut button = Button { label: String::from("OK"), on_click: |s: &str| log.push(s.len()) };
    button.click();
    button.click();
    println!("{:?}", log);

    let mut items = vec![
        Item { name: String::from("pear"), price: 3 },
        Item { name: String::from("fig"), price: 9 },
        Item { name: String::from("kiwi"), price: 5 },
    ];
    items.sort_by_key(|i| i.price);
    let limit = 4;
    let names: Vec<&str> = items.iter().filter(|i| i.price > limit).map(|i| i.name.as_str()).collect();
    println!("{}", names.join(", "));
    println!("{}", items.iter().fold(0, |sum, i| sum + i.price));
    println!("{:?}", items.iter().find(|i| i.name.starts_with("k")));
    println!("{:?}", Some(3).map(|x| x * x).filter(|x| *x > 5).unwrap_or_else(|| 0));
    println!("{:?}", Vec::from_fn(4, |i| i * i));
    println!("{}", Box::map(Box::new(20), |x| x + 1));
}
