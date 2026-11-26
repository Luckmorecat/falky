use std::cell::Cell;

use crate::shell::{PlanarFrame, Plane};

#[derive(Debug)]
pub(crate) struct Picture {
    width: u32,
    height: u32,
    planes: [(Vec<u8>, usize); 3],
}

impl Picture {
    pub(crate) fn new(width: u32, height: u32, variant: usize) -> Self {
        let width_uv = width.div_ceil(2);
        let height_uv = height.div_ceil(2);
        let planes = [
            (width, height),
            (width_uv, height_uv),
            (width_uv, height_uv),
        ]
        .map(|(width, height)| ((width as usize + 7), height as usize));
        let planes = std::array::from_fn(|index| {
            let (stride, rows) = planes[index];
            let bytes = (0..stride * rows)
                .map(|i| {
                    let x = i % stride;
                    let y = i / stride;
                    16 + ((x * (index + 3) + y * 11 + variant) % 220) as u8
                })
                .collect();
            (bytes, stride)
        });
        Self {
            width,
            height,
            planes,
        }
    }
}

impl PlanarFrame for Picture {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn planes(&self) -> [Plane<'_>; 3] {
        self.planes.each_ref().map(|(bytes, stride)| Plane {
            bytes,
            stride: *stride,
        })
    }
}

#[derive(Clone, Copy, Default)]
pub(crate) struct GpuWork {
    pub passes: u64,
    pub submissions: u64,
    pub uploads: u64,
}

thread_local! {
    static GPU: Cell<Option<GpuWork>> = const { Cell::new(None) };
}

pub(crate) fn gpu_event(update: impl FnOnce(&mut GpuWork)) {
    GPU.with(|slot| {
        if let Some(mut work) = slot.get() {
            update(&mut work);
            slot.set(Some(work));
        }
    });
}

pub(crate) fn gpu_frame<T>(draw: impl FnOnce() -> T) -> (T, GpuWork) {
    GPU.with(|slot| assert!(slot.replace(Some(GpuWork::default())).is_none()));
    let output = draw();
    (output, GPU.with(|slot| slot.replace(None).unwrap()))
}
