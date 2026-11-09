// error[E0597]: `x` does not live long enough
// `r` would point at `x` after `x` is gone.
fn main() {
    let r;
    {
        let x = 5;
        r = &x;
    }
    println!("{}", r);
}
