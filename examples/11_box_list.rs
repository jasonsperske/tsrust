// Box<T> puts a value on the heap. Recursive types need it: without the
// indirection, `List` would contain itself and have infinite size (E0072).

#[derive(Debug)]
enum List {
    Cons(i32, Box<List>),
    Nil,
}

use List::{Cons, Nil};

impl List {
    fn sum(&self) -> i32 {
        match self {
            Cons(value, rest) => value + rest.sum(),
            Nil => 0,
        }
    }

    fn push_front(self, value: i32) -> List {
        Cons(value, Box::new(self))
    }
}

// A binary search tree.
#[derive(Debug)]
struct Tree {
    root: Option<Box<Node>>,
}

#[derive(Debug)]
struct Node {
    value: i32,
    left: Option<Box<Node>>,
    right: Option<Box<Node>>,
}

impl Tree {
    fn new() -> Tree {
        Tree { root: None }
    }

    fn insert(&mut self, value: i32) {
        let mut slot = &mut self.root;
        while let Some(node) = slot {
            slot = if value < node.value { &mut node.left } else { &mut node.right };
        }
        *slot = Some(Box::new(Node { value, left: None, right: None }));
    }

    fn in_order(&self) -> Vec<i32> {
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out
    }
}

fn walk(node: &Option<Box<Node>>, out: &mut Vec<i32>) {
    if let Some(n) = node {
        walk(&n.left, out);
        out.push(n.value);
        walk(&n.right, out);
    }
}

fn main() {
    let list = Nil.push_front(3).push_front(2).push_front(1);
    println!("{:?}", list);
    println!("sum = {}", list.sum());

    let mut tree = Tree::new();
    for v in vec![50, 30, 70, 20, 40, 60, 80].iter() {
        tree.insert(*v);
    }
    println!("in order: {:?}", tree.in_order());

    let boxed = Box::new(41);
    println!("{}", *boxed + 1);
}
