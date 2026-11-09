// error[E0603]: function `secret` is private
mod vault {
    fn secret() -> u32 { 42 }
    pub fn public() -> u32 { secret() }
}

fn main() {
    println!("{}", vault::public());
    println!("{}", vault::secret());
}
