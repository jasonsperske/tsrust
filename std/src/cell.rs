//! `UnsafeCell<T>`: the one way to get mutable access through a shared
//! reference. You get a raw pointer, and upholding the aliasing rules is your job.

pub struct UnsafeCell<T> {
    value: T,
}

impl<T> UnsafeCell<T> {
    pub fn new(value: T) -> UnsafeCell<T> {
        UnsafeCell { value: value }
    }

    pub fn into_inner(self) -> T {
        self.value
    }

    pub fn get(&self) -> *mut T {
        &self.value as *const T as *mut T
    }

    pub fn get_mut(&mut self) -> &mut T {
        &mut self.value
    }

    pub unsafe fn replace(&self, value: T) -> T {
        crate::ptr::replace(self.get(), value)
    }

    pub unsafe fn as_ref_unchecked(&self) -> &T {
        &*self.get()
    }

    pub unsafe fn as_mut_unchecked(&self) -> &mut T {
        &mut *self.get()
    }
}

impl<T: Default> Default for UnsafeCell<T> {
    fn default() -> UnsafeCell<T> {
        UnsafeCell::new(T::default())
    }
}
