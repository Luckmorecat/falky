use std::time::{Duration, Instant};

use super::CaptureOptions;

pub(super) const BYTES_PER_PIXEL: usize = 4;

#[derive(Clone, Copy)]
pub(super) struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

pub(super) struct Frame<'a> {
    bytes: &'a [u8],
    stride: usize,
    flipped: bool,
    source_size: (u32, u32),
    crop: Rect,
}

#[derive(Default)]
pub(super) struct Scratch {
    pixels: Vec<u8>,
    source_size: (u32, u32),
}

impl<'a> Frame<'a> {
    pub fn new(
        bytes: &'a [u8],
        offset: u32,
        len: u32,
        stride: i32,
        width: u32,
        height: u32,
        crop: Option<Rect>,
    ) -> Option<Self> {
        let row_bytes = (width as usize).checked_mul(BYTES_PER_PIXEL)?;
        let flipped = stride < 0;
        let stride = if stride == 0 {
            row_bytes
        } else {
            stride.unsigned_abs() as usize
        };
        if width == 0 || height == 0 || stride < row_bytes || bytes.is_empty() {
            return None;
        }

        let offset = offset as usize % bytes.len();
        let end = offset.checked_add((len as usize).min(bytes.len()))?;
        let bytes = bytes.get(offset..end)?;
        let required = ((height - 1) as usize)
            .checked_mul(stride)?
            .checked_add(row_bytes)?;
        let bytes = bytes.get(..required)?;
        let crop = crop.unwrap_or(Rect {
            x: 0,
            y: 0,
            width,
            height,
        });
        if crop.width == 0
            || crop.height == 0
            || crop.x.checked_add(crop.width)? > width
            || crop.y.checked_add(crop.height)? > height
        {
            return None;
        }
        Some(Self {
            bytes,
            stride,
            source_size: (width, height),
            flipped,
            crop,
        })
    }

    pub fn pixels<'b>(
        &'b self,
        options: CaptureOptions,
        scratch: &'b mut Scratch,
    ) -> (u32, u32, usize, &'b [u8]) {
        let crop = self.crop;
        let (width, height) = fit(crop.width, crop.height, options);
        let row_len = width as usize * BYTES_PER_PIXEL;
        if width == crop.width && height == crop.height && !self.flipped {
            let (source_width, source_height) = self.source_size;
            let (cached_width, cached_height) = scratch.source_size;
            if source_width <= cached_width
                && source_height <= cached_height
                && self.source_size != scratch.source_size
            {
                *scratch = Scratch::default();
            }
            let offset = self.row_start(0);
            let end = offset + (height - 1) as usize * self.stride + row_len;
            return (width, height, self.stride, &self.bytes[offset..end]);
        }

        scratch.source_size = self.source_size;
        scratch.pixels.resize(row_len * height as usize, 0);
        for (y, row) in scratch.pixels.chunks_exact_mut(row_len).enumerate() {
            let source_y = sample(y, crop.height, height);
            let offset = self.row_start(source_y);
            let row_bytes = &self.bytes[offset..offset + crop.width as usize * BYTES_PER_PIXEL];
            if width == crop.width {
                row.copy_from_slice(row_bytes);
            } else {
                for (x, pixel) in row
                    .as_chunks_mut::<BYTES_PER_PIXEL>()
                    .0
                    .iter_mut()
                    .enumerate()
                {
                    let source_x = sample(x, crop.width, width) as usize * BYTES_PER_PIXEL;
                    pixel.copy_from_slice(&row_bytes[source_x..source_x + BYTES_PER_PIXEL]);
                }
            }
        }
        (width, height, row_len, &scratch.pixels)
    }

    fn row_start(&self, y: u32) -> usize {
        let y = self.crop.y + y;
        let row = if self.flipped {
            self.source_size.1 - 1 - y
        } else {
            y
        };
        row as usize * self.stride + self.crop.x as usize * BYTES_PER_PIXEL
    }
}

fn sample(position: usize, source: u32, output: u32) -> u32 {
    ((position as u64 * u64::from(source) + u64::from(source / 2)) / u64::from(output)) as u32
}

fn fit(width: u32, height: u32, options: CaptureOptions) -> (u32, u32) {
    let (width, height) = (u64::from(width), u64::from(height));
    let (max_width, max_height) = if width < height {
        (options.max_height, options.max_width)
    } else {
        (options.max_width, options.max_height)
    };
    let (max_width, max_height) = (u64::from(max_width), u64::from(max_height));
    if width <= max_width && height <= max_height {
        (width as u32, height as u32)
    } else if width * max_height > height * max_width {
        (max_width as u32, (height * max_width / width).max(1) as u32)
    } else {
        (
            (width * max_height / height).max(1) as u32,
            max_height as u32,
        )
    }
}

pub(super) struct Pacing {
    interval: Duration,
    next: Option<Instant>,
}

impl Pacing {
    pub fn new(fps: u32) -> Self {
        Self {
            interval: Duration::from_secs(1) / fps,
            next: None,
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| now >= next)
    }

    pub fn sent(&mut self, now: Instant) {
        // Keep a regular schedule for a source whose frames straddle the deadline.
        let next = self.next.unwrap_or(now) + self.interval;
        self.next = Some(if next > now {
            next
        } else {
            now + self.interval
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "release scoreboard"]
    fn scoreboard_linux_capture_downsize() {
        use crate::perf;

        fn frame(bytes: &[u8], width: u32, height: u32) -> Frame<'_> {
            Frame::new(
                bytes,
                0,
                bytes.len() as u32,
                width as i32 * 4,
                width,
                height,
                None,
            )
            .expect("valid PipeWire frame")
        }

        let high = perf::packed_pixels(3840, 2160, 3840 * 4);
        let low = perf::packed_pixels(1920, 1080, 1920 * 4);
        let (high, low) = (frame(&high, 3840, 2160), frame(&low, 1920, 1080));
        let start = perf::live_bytes();
        let mut scratch = Scratch::default();
        let (_, _, _, first) = high.pixels(options(2560, 1440), &mut scratch);
        perf::golden("capture.linux.downsize.high", &[first]);
        let (_, _, _, second) = low.pixels(options(2560, 1440), &mut scratch);
        perf::golden("capture.linux.downsize.low", &[second]);
        let retained = perf::live_bytes() - start;
        std::hint::black_box(&scratch);
        perf::metric("capture.linux.downsize.retained_bytes", retained);
    }

    #[test]
    #[ignore = "release scoreboard"]
    fn scoreboard_linux_capture_repacked_downsize() {
        use crate::perf;

        let high_bytes = perf::packed_pixels(3840, 2160, 3840 * 4);
        let low_stride = 1920 * 4 + 16;
        let low_bytes = perf::packed_pixels(1920, 1080, low_stride);
        let high = Frame::new(
            &high_bytes,
            0,
            high_bytes.len() as u32,
            3840 * 4,
            3840,
            2160,
            None,
        )
        .unwrap();
        let low = Frame::new(
            &low_bytes,
            0,
            low_bytes.len() as u32,
            -(low_stride as i32),
            1920,
            1080,
            None,
        )
        .unwrap();

        let options = options(2560, 1440);
        let start = perf::live_bytes();
        let mut scratch = Default::default();
        let (width, height, stride, pixels) = high.pixels(options, &mut scratch);
        assert_eq!((width, height, stride), (2560, 1440, 2560 * 4));
        let high_hash = perf::hash(&[pixels]);

        let (width, height, stride, pixels) = low.pixels(options, &mut scratch);
        let retained = perf::live_bytes() - start;
        assert_eq!((width, height, stride), (1920, 1080, 1920 * 4));
        assert_eq!(pixels.len(), stride * height as usize);
        assert!(
            pixels
                .chunks_exact(stride)
                .zip(low_bytes.chunks_exact(low_stride).rev())
                .all(|(actual, expected)| actual == &expected[..stride])
        );
        perf::golden("capture.linux.repacked_downsize", &[pixels]);

        let (width, height, stride, restarted) = high.pixels(options, &mut scratch);
        assert_eq!((width, height, stride), (2560, 1440, 2560 * 4));
        assert_eq!(perf::hash(&[restarted]), high_hash);
        perf::metric("capture.linux.repacked_downsize.retained_bytes", retained);
    }

    fn options(width: u32, height: u32) -> CaptureOptions {
        CaptureOptions {
            max_width: width,
            max_height: height,
            fps: 30,
            with_audio: false,
        }
    }

    #[test]
    fn pitched_rows_and_chunk_offset() {
        let bytes = [0; 45];
        let frame = Frame::new(&bytes, 48, 36, 12, 2, 3, None).unwrap();
        let mut scratch = Scratch::default();
        let (width, height, stride, pixels) = frame.pixels(options(16, 9), &mut scratch);
        assert_eq!((width, height, stride), (2, 3, 12));
        assert_eq!(pixels.as_ptr(), bytes[3..].as_ptr());
        assert_eq!(pixels.len(), 32);

        assert!(Frame::new(&bytes, 3, 31, 12, 2, 3, None).is_none());
        assert!(Frame::new(&bytes, 3, 36, 7, 2, 3, None).is_none());
        assert!(Frame::new(&bytes, 30, 35, 12, 2, 3, None).is_none());
    }

    #[test]
    fn video_crop_and_bottom_up_rows() {
        let bytes = [
            1, 1, 1, 1, 2, 2, 2, 2, 99, 99, 99, 99, 3, 3, 3, 3, 4, 4, 4, 4,
        ];
        let crop = Rect {
            x: 1,
            y: 0,
            width: 1,
            height: 2,
        };
        let frame = Frame::new(&bytes, 0, 20, -12, 2, 2, Some(crop)).unwrap();
        let mut scratch = Scratch::default();
        let (width, height, stride, pixels) = frame.pixels(options(16, 9), &mut scratch);
        assert_eq!((width, height, stride), (1, 2, 4));
        assert_eq!(pixels, &[4, 4, 4, 4, 2, 2, 2, 2]);

        assert!(Frame::new(&bytes, 0, 20, 12, 2, 2, Some(Rect { x: 2, ..crop })).is_none());
    }

    #[test]
    fn aspect_ratio_and_portrait_size_cap() {
        let options = options(1920, 1080);
        assert_eq!(fit(3840, 2160, options), (1920, 1080));
        assert_eq!(fit(2160, 3840, options), (1080, 1920));
        assert_eq!(fit(3840, 1080, options), (1920, 540));
        assert_eq!(fit(720, 1280, options), (720, 1280));
    }

    #[test]
    fn resizes_the_active_region_into_packed_rows() {
        let pixels: Vec<u8> = (0..32).collect();
        let frame = Frame::new(&pixels, 0, 32, 16, 4, 2, None).unwrap();
        let mut scratch = Scratch::default();
        let (width, height, stride, pixels) = frame.pixels(options(2, 1), &mut scratch);
        assert_eq!((width, height, stride), (2, 1, 8));
        assert_eq!(pixels, &[20, 21, 22, 23, 28, 29, 30, 31]);
    }

    #[test]
    fn releases_resize_scratch_on_a_smaller_borrowed_source() {
        let bytes: Vec<u8> = (0..32).collect();
        let large = Frame::new(&bytes, 0, 32, 16, 4, 2, None).unwrap();
        let cropped = Frame::new(
            &bytes,
            0,
            32,
            16,
            4,
            2,
            Some(Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 1,
            }),
        )
        .unwrap();
        let small = Frame::new(&bytes, 0, 8, 8, 2, 1, None).unwrap();
        let fit = options(2, 1);
        let mut scratch = Scratch::default();
        let (_, _, _, first) = large.pixels(fit, &mut scratch);
        let expected = first.to_vec();
        let capacity = scratch.pixels.capacity();

        let (_, _, _, direct) = cropped.pixels(fit, &mut scratch);
        assert_eq!(direct.as_ptr(), bytes.as_ptr());
        assert_eq!(scratch.pixels.capacity(), capacity);
        let (_, _, _, direct) = small.pixels(fit, &mut scratch);
        assert_eq!(direct, &bytes[..8]);
        assert_eq!(direct.as_ptr(), bytes.as_ptr());
        assert_eq!(scratch.pixels.capacity(), 0);

        let (_, _, _, restarted) = large.pixels(fit, &mut scratch);
        assert_eq!(restarted, expected);
    }

    #[test]
    fn pacing_drops_early_frames_and_recovers_from_gaps() {
        let mut pacing = Pacing::new(25);
        let now = Instant::now();
        assert!(pacing.due(now));
        pacing.sent(now);
        assert!(!pacing.due(now + Duration::from_millis(39)));
        let later = now + Duration::from_millis(50);
        assert!(pacing.due(later));
        pacing.sent(later);
        assert!(pacing.due(now + Duration::from_millis(80)));
        let resumed = now + Duration::from_secs(2);
        assert!(pacing.due(resumed));
        pacing.sent(resumed);
        assert!(!pacing.due(resumed + Duration::from_millis(39)));
    }
}
