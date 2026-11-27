use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hash::{DefaultHasher, Hasher},
    hint::black_box,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Instant,
};

thread_local! {
    static ALLOCATIONS: Cell<Option<u64>> = const { Cell::new(None) };
}

struct CountingAllocator;

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

struct Heap {
    live: i64,
    peaks: [Option<i64>; 2],
}

static HEAP: Mutex<Heap> = Mutex::new(Heap {
    live: 0,
    peaks: [None; 2],
});

fn heap() -> MutexGuard<'static, Heap> {
    HEAP.lock().unwrap_or_else(PoisonError::into_inner)
}

fn resize(old: usize, new: usize) {
    let mut heap = heap();
    heap.live += new as i64 - old as i64;
    let live = heap.live;
    for peak in heap.peaks.iter_mut().flatten() {
        *peak = (*peak).max(live);
    }
}

pub(crate) fn live_bytes() -> i64 {
    heap().live
}

#[cfg(target_os = "linux")]
pub(crate) fn process_bytes() -> (u64, u64) {
    fn field(path: &str, name: &str) -> u64 {
        std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("read {path}: {error}"))
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or_else(|| panic!("missing {name} in {path}"))
            * 1024
    }
    (
        field("/proc/self/smaps_rollup", "Pss_Anon:"),
        field("/proc/self/status", "VmHWM:"),
    )
}

pub(crate) struct HeapWindow {
    pub start: i64,
    slot: Option<usize>,
}

impl HeapWindow {
    pub(crate) fn start() -> Self {
        let mut heap = heap();
        let start = heap.live;
        let slot = heap.peaks.iter().position(Option::is_none);
        if let Some(slot) = slot {
            heap.peaks[slot] = Some(start);
        }
        drop(heap);
        assert!(slot.is_some(), "heap window nesting limit");
        Self { start, slot }
    }

    pub(crate) fn finish(mut self) -> i64 {
        let slot = self.slot.take().expect("allocated heap window");
        let peak = heap().peaks[slot].take();
        peak.expect("active heap window") - self.start
    }
}

impl Drop for HeapWindow {
    fn drop(&mut self) {
        if let Some(slot) = self.slot {
            heap().peaks[slot] = None;
        }
    }
}

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
        let result = unsafe { System.alloc(layout) };
        if !result.is_null() {
            resize(0, layout.size());
        }
        result
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_allocation();
        let result = unsafe { System.alloc_zeroed(layout) };
        if !result.is_null() {
            resize(0, layout.size());
        }
        result
    }

    unsafe fn realloc(&self, ptr: *mut u8, old: Layout, size: usize) -> *mut u8 {
        count_allocation();
        let result = unsafe { System.realloc(ptr, old, size) };
        if !result.is_null() {
            resize(old.size(), size);
        }
        result
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        resize(layout.size(), 0);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Sample {
    pub nanoseconds: u64,
    pub allocations: u64,
    pub peak_bytes: i64,
    pub residue_bytes: i64,
    pub start_bytes: i64,
}

pub(crate) fn measure<T>(operation: impl FnOnce() -> T) -> (T, Sample) {
    let window = HeapWindow::start();
    assert!(ALLOCATIONS.with(|count| count.replace(Some(0))).is_none());
    let start = Instant::now();
    let value = black_box(operation());
    let nanoseconds = start.elapsed().as_nanos() as u64;
    let allocations = ALLOCATIONS.with(|count| count.replace(None).unwrap());
    let start_bytes = window.start;
    let peak_bytes = window.finish();
    (
        value,
        Sample {
            nanoseconds,
            allocations,
            peak_bytes,
            residue_bytes: live_bytes() - start_bytes,
            start_bytes,
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
    let mut residues = samples
        .iter()
        .map(|sample| sample.residue_bytes)
        .collect::<Vec<_>>();
    residues.sort_unstable();
    let peak = samples
        .iter()
        .map(|sample| sample.peak_bytes)
        .max()
        .unwrap();
    metric(&format!("{name}.peak_bytes"), peak);
    metric(&format!("{name}.residue_bytes"), residues[count / 2]);
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
        let (output, mut sample) = measure(|| operation(value));
        drop(output);
        sample.residue_bytes = live_bytes() - sample.start_bytes;
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
