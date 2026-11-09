// Welcome to TSRust! Press "Run" to compile this program in your browser.
// Every stage of the compiler is visible in the tabs on the right.

fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

fn main() {
    let message = greet("TSRust");
    println!("{}", message);

    // Variables are immutable by default. `mut` opts in to mutation.
    let mut counter = 0;
    while counter < 3 {
        counter += 1;
        println!("counting: {counter}");
    }

    // Blocks are expressions: the last expression is the value.
    let parity = if counter % 2 == 0 { "even" } else { "odd" };
    println!("{} is {}", counter, parity);

    // Integer literals default to i32; floats to f64.
    let x = 7;
    let y = 2.5;
    println!("{} / 2 = {}, {} * 2 = {}", x, x / 2, y, y * 2.0);
}
