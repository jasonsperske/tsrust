use crate::Area;

pub struct Square {
    side: f64,
}

impl Square {
    pub fn new(side: f64) -> Square {
        Square { side }
    }
}

impl Area for Square {
    fn area(&self) -> f64 {
        self.side * self.side
    }
}
