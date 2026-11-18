// Arrays hold a fixed number of elements. Slices are borrowed views of
// consecutive elements, and can point into arrays, vectors or other slices.

const SIZE: usize = 3;

fn sum(values: &[i32]) -> i32 {
    let mut total = 0;
    for v in values {
        total += v;
    }
    total
}

fn zero_first(values: &mut [i32]) {
    if let Some(first) = values.first_mut() {
        *first = 0;
    }
}

fn describe(values: &[i32]) -> String {
    match values {
        [] => String::from("empty"),
        [one] => format!("just {}", one),
        [first, .., last] if first == last => format!("bookends {}", first),
        [first, rest @ ..] => format!("{} then {} more", first, rest.len()),
    }
}

fn quicksort(a: &mut [i32]) {
    if a.len() < 2 {
        return;
    }
    let last = a.len() - 1;
    let pivot = a[last];
    let mut store = 0;
    for i in 0..last {
        if a[i] < pivot {
            a.swap(store, i);
            store += 1;
        }
    }
    a.swap(store, last);
    let (left, right) = a.split_at_mut(store);
    quicksort(left);
    quicksort(&mut right[1..]);
}

// A const generic: this works for arrays of any length.
fn length<T, const N: usize>(_array: &[T; N]) -> usize {
    N
}

fn main() {
    let mut numbers = [4, 8, 15, 16, 23, 42];
    println!("{:?} {}", numbers, numbers.len());
    println!("{} {}", sum(&numbers), sum(&numbers[1..3]));

    // Arrays of `Copy` values are copied, not aliased.
    let copy = numbers;
    zero_first(&mut numbers[2..]);
    println!("{:?}\n{:?}", numbers, copy);

    let vector = vec![1, 2, 3];
    println!("{} {}", sum(&vector), vector == [1, 2, 3]);

    println!("{}", describe(&[]));
    println!("{}", describe(&[7]));
    println!("{}", describe(&[7, 1, 7]));
    println!("{}", describe(&[1, 2, 3]));

    let mut grid = [[0; SIZE]; SIZE];
    for (i, row) in grid.iter_mut().enumerate() {
        row[i] = 1;
    }
    println!("{:?}", grid);

    let mut data = [9, 3, 7, 1, 8];
    quicksort(&mut data);
    println!("{:?} {:?}", data, data.binary_search(&7));

    println!("{:?}", data.windows(2).map(|w| w[1] - w[0]).collect::<Vec<_>>());
    println!("{:?}", data.chunks(2).collect::<Vec<_>>());
    println!("{:?}", data.iter().rev().take(2).collect::<Vec<_>>());
    println!("{:?} {:?}", data.trim_prefix(&[1, 3]), data.trim_suffix(&[100]));
    println!("{:?}", [1, 2, 3].map(|x| x * 10));
    println!("{}", length(&["a", "b"]));
    println!("{}", ["x", "y", "z"].join("-"));

    let [a, b, ..] = data;
    println!("{}", a + b);
}
