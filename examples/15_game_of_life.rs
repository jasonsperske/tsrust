// Conway's Game of Life on a small wrapping grid.

#[derive(Clone, Copy, PartialEq)]
enum Cell {
    Dead,
    Alive,
}

struct Grid {
    width: usize,
    height: usize,
    cells: Vec<Cell>,
}

impl Grid {
    fn new(width: usize, height: usize) -> Grid {
        Grid { width, height, cells: vec![Cell::Dead; width * height] }
    }

    fn set(&mut self, x: usize, y: usize) {
        let i = y * self.width + x;
        self.cells[i] = Cell::Alive;
    }

    fn alive_neighbors(&self, x: usize, y: usize) -> u32 {
        let mut count = 0;
        for dy in 0..3 {
            for dx in 0..3 {
                if dx == 1 && dy == 1 {
                    continue;
                }
                let nx = (x + self.width + dx - 1) % self.width;
                let ny = (y + self.height + dy - 1) % self.height;
                if self.cells[ny * self.width + nx] == Cell::Alive {
                    count += 1;
                }
            }
        }
        count
    }

    fn step(&self) -> Grid {
        let mut next = Grid::new(self.width, self.height);
        for y in 0..self.height {
            for x in 0..self.width {
                let n = self.alive_neighbors(x, y);
                let alive = self.cells[y * self.width + x] == Cell::Alive;
                if (alive && (n == 2 || n == 3)) || (!alive && n == 3) {
                    next.set(x, y);
                }
            }
        }
        next
    }

    fn render(&self) -> String {
        let mut s = String::new();
        for y in 0..self.height {
            for x in 0..self.width {
                s.push(if self.cells[y * self.width + x] == Cell::Alive { '#' } else { '.' });
            }
            s.push('\n');
        }
        s
    }
}

fn main() {
    let mut grid = Grid::new(8, 6);
    // A glider.
    grid.set(1, 0);
    grid.set(2, 1);
    grid.set(0, 2);
    grid.set(1, 2);
    grid.set(2, 2);
    for generation in 0..3 {
        println!("generation {}:", generation);
        print!("{}", grid.render());
        grid = grid.step();
    }
}
