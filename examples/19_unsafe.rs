// `unsafe` unlocks a few extra powers. The compiler stops checking those
// operations, so keeping them valid becomes your responsibility.

use std::cell::UnsafeCell;
use std::mem;
use std::ptr;
use std::slice;

static GREETING: &str = "hello";
static mut COUNTER: u32 = 0;

fn next_id() -> u32 {
    unsafe {
        COUNTER += 1;
        COUNTER
    }
}

unsafe fn write_twice(p: *mut i32, value: i32) {
    *p = value;
    *p += value;
}

unsafe trait Zeroed {
    fn zeroed() -> Self;
}

unsafe impl Zeroed for u8 {
    fn zeroed() -> u8 {
        0
    }
}

// A safe function built on unsafe code, like the real `split_at_mut`.
fn split_pair(s: &mut [i32], mid: usize) -> (&mut [i32], &mut [i32]) {
    assert!(mid <= s.len());
    let len = s.len();
    let p = s.as_mut_ptr();
    unsafe { (slice::from_raw_parts_mut(p, mid), slice::from_raw_parts_mut(p.add(mid), len - mid)) }
}

struct Node {
    value: i32,
    next: *mut Node,
}

struct Stack {
    head: *mut Node,
}

impl Stack {
    fn push(&mut self, value: i32) {
        self.head = Box::into_raw(Box::new(Node { value, next: self.head }));
    }

    fn pop(&mut self) -> Option<i32> {
        if self.head.is_null() {
            return None;
        }
        let node = unsafe { Box::from_raw(self.head) };
        self.head = node.next;
        Some(node.value)
    }
}

#[derive(Debug)]
struct Marker;

fn main() {
    let mut x = 1;
    let p = &mut x as *mut i32;
    unsafe {
        write_twice(p, 21);
        println!("{}", *p);
    }
    println!("{}", x);

    let field = (1, 2);
    let second = &raw const field.1;
    println!("{}", unsafe { *second });

    next_id();
    println!("{} {}", GREETING, next_id());
    println!("{}", u8::zeroed());

    let mut numbers = [1, 2, 3, 4];
    let (left, right) = split_pair(&mut numbers, 1);
    left[0] = 10;
    right[0] = 20;
    println!("{:?}", numbers);

    let mut stack = Stack { head: ptr::null_mut() };
    stack.push(1);
    stack.push(2);
    println!("{:?} {:?} {:?}", stack.pop(), stack.pop(), stack.pop());

    let cell = UnsafeCell::new(5);
    unsafe {
        *cell.get() += 1;
        println!("{} {}", cell.replace(9), cell.as_ref_unchecked());
    }

    let marker: Marker = unsafe { mem::conjure_zst() };
    println!("{:?}", marker);
}
