// error[E0004]: non-exhaustive patterns
// The compiler proves every enum variant is handled.
enum Direction { North, South, East, West }

fn turn(d: Direction) -> &'static str {
    match d {
        Direction::North => "up",
        Direction::South => "down",
        Direction::East => "right",
    }
}

fn main() {
    println!("{}", turn(Direction::West));
}
