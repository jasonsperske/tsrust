//! Raw pointers: `*const T` and `*mut T`. Unlike references they may be null
//! or dangling and nothing tracks what they alias, so reading through one is
//! `unsafe`: keeping it valid is up to you.

pub fn null<T>() -> *const T;
pub fn null_mut<T>() -> *mut T;
pub unsafe fn read<T>(src: *const T) -> T;
pub unsafe fn write<T>(dst: *mut T, value: T);

pub unsafe fn replace<T>(dst: *mut T, value: T) -> T {
    let old = read(dst as *const T);
    write(dst, value);
    old
}

pub unsafe fn swap<T>(a: *mut T, b: *mut T) {
    let x = read(a as *const T);
    write(a, read(b as *const T));
    write(b, x);
}

pub fn eq<T>(a: *const T, b: *const T) -> bool {
    a == b
}

impl<T> *const T {
    pub fn is_null(self) -> bool;
    pub unsafe fn offset(self, count: isize) -> *const T;

    pub unsafe fn add(self, count: usize) -> *const T {
        self.offset(count as isize)
    }

    pub unsafe fn sub(self, count: usize) -> *const T {
        self.offset(-(count as isize))
    }

    pub unsafe fn read(self) -> T {
        read(self)
    }

    pub unsafe fn as_ref<'a>(self) -> Option<&'a T> {
        if self.is_null() { None } else { Some(&*self) }
    }

    pub fn cast_mut(self) -> *mut T {
        self as *mut T
    }
}

impl<T> *mut T {
    pub fn is_null(self) -> bool;
    pub unsafe fn offset(self, count: isize) -> *mut T;

    pub unsafe fn add(self, count: usize) -> *mut T {
        self.offset(count as isize)
    }

    pub unsafe fn sub(self, count: usize) -> *mut T {
        self.offset(-(count as isize))
    }

    pub unsafe fn read(self) -> T {
        read(self as *const T)
    }

    pub unsafe fn write(self, value: T) {
        write(self, value)
    }

    pub unsafe fn replace(self, value: T) -> T {
        replace(self, value)
    }

    pub unsafe fn as_ref<'a>(self) -> Option<&'a T> {
        if self.is_null() { None } else { Some(&*self) }
    }

    pub unsafe fn as_mut<'a>(self) -> Option<&'a mut T> {
        if self.is_null() { None } else { Some(&mut *self) }
    }

    pub fn cast_const(self) -> *const T {
        self as *const T
    }
}
