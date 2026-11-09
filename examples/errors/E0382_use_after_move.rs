// error[E0382]: use of moved value
// `String` isn't Copy, so `let t = s;` moves ownership into `t`.
fn main() {
    let s = String::from("hello");
    let t = s;
    println!("{} {}", s, t);
}
