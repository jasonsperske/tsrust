pub const PI: f64 = 3.14159265;

pub fn banner(title: &str) -> String {
    format!("=== {} ===", title)
}

pub fn stars(n: usize) -> String {
    "*".repeat(n)
}
