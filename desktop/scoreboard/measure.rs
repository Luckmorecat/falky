use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hash::{DefaultHasher, Hasher},
    hint::black_box,
    time::Instant,
};

thread_local! {
    static ALLOCATIONS: Cell<Option<u64>> = const { Cell::new(None) };
}

struct CountingAllocator;

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn count_allocation() {
    let _ = ALLOCATIONS.try_with(|count| {
        if let Some(current) = count.get() {
            count.set(Some(current + 1));
        }
    });
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, size: usize) -> *mut u8 {
        count_allocation();
        unsafe { System.realloc(ptr, old, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Sample {
    pub nanoseconds: u64,
    pub allocations: u64,
}

pub(crate) fn measure<T>(operation: impl FnOnce() -> T) -> (T, Sample) {
    assert!(ALLOCATIONS.with(|count| count.replace(Some(0))).is_none());
    let start = Instant::now();
    let value = black_box(operation());
    let nanoseconds = start.elapsed().as_nanos() as u64;
    let allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    (
        value,
        Sample {
            nanoseconds,
            allocations,
        },
    )
}

pub(crate) fn metric(name: &str, value: impl std::fmt::Display) {
    println!("falky-perf {name} {value}");
}

pub(crate) fn report(name: &str, samples: &[Sample]) {
    let mut times = samples
        .iter()
        .map(|sample| sample.nanoseconds)
        .collect::<Vec<_>>();
    times.sort_unstable();
    let count = times.len();
    let median = times[count / 2] as f64 / 1_000.0;
    let p99 = times[(count * 99).div_ceil(100) - 1] as f64 / 1_000.0;
    let allocations =
        samples.iter().map(|sample| sample.allocations).sum::<u64>() as f64 / count as f64;
    metric(&format!("{name}.median_us"), median);
    metric(&format!("{name}.p99_us"), p99);
    metric(&format!("{name}.allocations"), allocations);
}

pub(crate) fn golden(name: &str, parts: &[&[u8]]) {
    println!("falky-golden {name} {:016x}", hash(parts));
}

pub(crate) fn hash(parts: &[&[u8]]) -> u64 {
    let mut hash = DefaultHasher::new();
    for part in parts {
        hash.write_usize(part.len());
        hash.write(part);
    }
    hash.finish()
}

pub(crate) fn repeat<T>(name: &str, trials: usize, mut operation: impl FnMut() -> T) -> T {
    repeat_with(name, trials, || (), |()| operation())
}

pub(crate) fn repeat_with<I, T>(
    name: &str,
    trials: usize,
    mut input: impl FnMut() -> I,
    mut operation: impl FnMut(I) -> T,
) -> T {
    black_box(operation(input()));
    let mut samples = Vec::with_capacity(trials);
    for _ in 0..trials {
        let value = black_box(input());
        let (_, sample) = measure(|| operation(value));
        samples.push(sample);
    }
    report(name, &samples);
    operation(input())
}

pub(crate) fn packed_pixels(width: usize, height: usize, stride: usize) -> Vec<u8> {
    let mut bytes = vec![0; stride * height];
    for (y, row) in bytes.chunks_exact_mut(stride).enumerate() {
        for (x, pixel) in row[..width * 4]
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .enumerate()
        {
            pixel.copy_from_slice(&[
                (x + y * 3) as u8,
                (x * 7 + y) as u8,
                ((x / 8) ^ (y * 5)) as u8,
                255,
            ]);
        }
    }
    bytes
}
