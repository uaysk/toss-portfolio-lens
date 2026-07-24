#[derive(Debug, Clone)]
pub(super) struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    pub(super) fn new(seed: u64) -> Self {
        let mut state = seed as u32;
        if state == 0 {
            state = 0x6D2B79F5;
        }
        Self { state }
    }

    pub(super) fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6D2B79F5);
        let mut value = self.state;
        value = (value ^ (value >> 15)).wrapping_mul(value | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        ((value ^ (value >> 14)) as f64) / 4_294_967_296.0
    }

    pub(super) fn next_int(&mut self, maximum: usize) -> usize {
        if maximum == 0 {
            0
        } else {
            (self.next() * maximum as f64).floor() as usize
        }
    }

    pub(super) fn normal(&mut self) -> f64 {
        let left = self.next().max(f64::MIN_POSITIVE);
        let right = self.next();
        (-2.0 * left.ln()).sqrt() * (std::f64::consts::TAU * right).cos()
    }
}
