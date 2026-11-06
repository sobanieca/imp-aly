use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

const MULTIPLIER: u64 = 0x517c_c1b7_2722_0a95;

#[derive(Default, Clone, Copy)]
pub struct FastHasher(u64);

impl FastHasher {
    fn add(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(MULTIPLIER);
    }
}

impl Hasher for FastHasher {
    fn finish(&self) -> u64 {
        let mut hash = self.0;
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xff51_afd7_ed55_8ccd);
        hash ^= hash >> 33;
        hash = hash.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        hash ^ (hash >> 33)
    }

    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for word in words {
            self.add(u64::from_le_bytes(*word));
        }
        for byte in rest {
            self.add(u64::from(*byte));
        }
    }

    fn write_u8(&mut self, value: u8) {
        self.add(u64::from(value));
    }

    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }

    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }

    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }
}

pub type FastMap<K, V> = HashMap<K, V, BuildHasherDefault<FastHasher>>;

pub struct IdKeys {
    radix: u64,
    packed: bool,
    small: FastMap<u64, usize>,
    large: FastMap<Vec<u32>, usize>,
}

impl IdKeys {
    pub fn new(fields: usize, values: usize) -> Self {
        let radix = values.max(1) as u64;
        let packed = (0..fields)
            .try_fold(1u64, |total, _| total.checked_mul(radix))
            .is_some();
        IdKeys {
            radix,
            packed,
            small: FastMap::default(),
            large: FastMap::default(),
        }
    }

    fn pack(&self, ids: &[u32]) -> u64 {
        ids.iter()
            .fold(0u64, |key, id| key * self.radix + u64::from(*id))
    }

    pub fn get(&self, ids: &[u32]) -> Option<usize> {
        if self.packed {
            self.small.get(&self.pack(ids)).copied()
        } else {
            self.large.get(ids).copied()
        }
    }

    pub fn insert(&mut self, ids: &[u32], target: usize) {
        if self.packed {
            let key = self.pack(ids);
            self.small.insert(key, target);
        } else {
            self.large.insert(ids.to_vec(), target);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packed_and_listed_keys_find_the_same_targets() {
        for (fields, values) in [(2, 10), (8, 1 << 20)] {
            let mut keys = IdKeys::new(fields, values);
            assert_eq!(keys.packed, fields == 2);
            let one: Vec<u32> = (0..fields as u32).collect();
            let other: Vec<u32> = (0..fields as u32).rev().collect();
            keys.insert(&one, 1);
            keys.insert(&other, 2);
            assert_eq!(keys.get(&one), Some(1));
            assert_eq!(keys.get(&other), Some(2));
            assert_eq!(keys.get(&vec![9; fields]), None);
        }
    }
}
