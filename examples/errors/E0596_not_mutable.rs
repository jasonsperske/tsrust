// error[E0596]: cannot borrow as mutable, as it is not declared as mutable
fn main() {
    let names = Vec::new();
    names.push("ferris");
}
