//! `HashMap<K, V>`. The VM stores entries natively and iterates them in
//! insertion order (real Rust iterates in an unspecified order).

use crate::fmt::Debug;
use crate::vec::Vec;

/// Types usable as hash map keys. Implemented natively for primitives and
/// strings, and by `#[derive(Hash)]`.
pub trait Hash {}

pub struct HashMap<K, V>;

impl<K: Hash + Eq, V> HashMap<K, V> {
    pub fn new() -> HashMap<K, V>;
    /// Insert, returning the previous value for this key, if any.
    pub fn insert(&mut self, key: K, value: V) -> Option<V>;
    pub fn get(&self, key: &K) -> Option<&V>;
    pub fn get_mut(&mut self, key: &K) -> Option<&mut V>;
    pub fn remove(&mut self, key: &K) -> Option<V>;
    pub fn contains_key(&self, key: &K) -> bool;
    pub fn len(&self) -> usize;
    pub fn clear(&mut self);

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The entry API: `*map.entry(word).or_insert(0) += 1;`
    pub fn entry(&mut self, key: K) -> Entry<K, V> {
        Entry { map: self, key: key }
    }

    pub fn keys(&self) -> Keys<K, V> {
        Keys { map: self, pos: 0 }
    }

    pub fn values(&self) -> Values<K, V> {
        Values { map: self, pos: 0 }
    }

    pub fn iter(&self) -> Iter<K, V> {
        Iter { map: self, pos: 0 }
    }
}

fn slot_count<K, V>(map: &HashMap<K, V>) -> usize;
fn slot<K, V>(map: &HashMap<K, V>, index: usize) -> Option<(&K, &V)>;
fn entry_ref<K, V>(map: &mut HashMap<K, V>, key: K, default: V) -> &mut V;

pub struct Entry<'a, K, V> {
    map: &'a mut HashMap<K, V>,
    key: K,
}

impl<'a, K: Hash + Eq, V> Entry<'a, K, V> {
    pub fn or_insert(self, default: V) -> &'a mut V {
        entry_ref(self.map, self.key, default)
    }
}

impl<'a, K: Hash + Eq, V: Default> Entry<'a, K, V> {
    pub fn or_default(self) -> &'a mut V {
        entry_ref(self.map, self.key, V::default())
    }
}

pub struct Iter<'a, K, V> {
    map: &'a HashMap<K, V>,
    pos: usize,
}

impl<'a, K, V> Iterator for Iter<'a, K, V> {
    type Item = (&'a K, &'a V);
    fn next(&mut self) -> Option<(&'a K, &'a V)> {
        while self.pos < slot_count(self.map) {
            let index = self.pos;
            self.pos += 1;
            match slot(self.map, index) {
                Some(pair) => return Some(pair),
                None => {}
            }
        }
        None
    }
}

pub struct Keys<'a, K, V> {
    map: &'a HashMap<K, V>,
    pos: usize,
}

impl<'a, K, V> Iterator for Keys<'a, K, V> {
    type Item = &'a K;
    fn next(&mut self) -> Option<&'a K> {
        while self.pos < slot_count(self.map) {
            let index = self.pos;
            self.pos += 1;
            match slot(self.map, index) {
                Some((k, _)) => return Some(k),
                None => {}
            }
        }
        None
    }
}

pub struct Values<'a, K, V> {
    map: &'a HashMap<K, V>,
    pos: usize,
}

impl<'a, K, V> Iterator for Values<'a, K, V> {
    type Item = &'a V;
    fn next(&mut self) -> Option<&'a V> {
        while self.pos < slot_count(self.map) {
            let index = self.pos;
            self.pos += 1;
            match slot(self.map, index) {
                Some((_, v)) => return Some(v),
                None => {}
            }
        }
        None
    }
}

impl<'a, K, V> IntoIterator for &'a HashMap<K, V> {
    type Item = (&'a K, &'a V);
    type IntoIter = Iter<'a, K, V>;
    fn into_iter(self) -> Iter<'a, K, V> {
        Iter { map: self, pos: 0 }
    }
}

impl<K: Debug, V: Debug> Debug for HashMap<K, V> {
    fn fmt(&self, f: &mut crate::fmt::Formatter) -> crate::fmt::Result;
}
