fn call_twice<F: Fn()>(f: F) {
    f();
    f();
}

fn main() {
    let name = String::from("once");
    let consume = || drop(name);
    call_twice(consume);
}
