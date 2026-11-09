use crate::Area;

pub struct Circle {
    radius: f64,
}

impl Circle {
    pub fn new(radius: f64) -> Circle {
        Circle { radius }
    }
}

impl Area for Circle {
    fn area(&self) -> f64 {
        util::PI * self.radius * self.radius
    }
}
