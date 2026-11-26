#[cfg(test)]
mod scoreboard;

use crate::audio::StereoBlock;
use livekit::webrtc::{
    native::yuv_helper::{abgr_to_i420, argb_to_i420},
    video_frame::{BoxVideoFrame, I420Buffer, VideoBuffer, VideoRotation},
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
    },
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_DIMENSION: u32 = 8192;
const MAX_PIXELS: u32 = 8192 * 4096;
const AUDIO_CAPACITY: usize = 960 * 8;
static FRAME_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct ShareFrame {
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub stride_y: usize,
    pub stride_u: usize,
    pub stride_v: usize,
    pub(super) timestamp_us: i64,
    buffer: I420Buffer,
}

impl ShareFrame {
    fn new(buffer: I420Buffer, timestamp_us: i64) -> Self {
        let (y, u, v) = buffer.strides();
        Self {
            sequence: FRAME_SEQUENCE.fetch_add(1, Relaxed),
            width: buffer.width(),
            height: buffer.height(),
            stride_y: y as usize,
            stride_u: u as usize,
            stride_v: v as usize,
            timestamp_us,
            buffer,
        }
    }

    pub fn planes(&self) -> (&[u8], &[u8], &[u8]) {
        self.buffer.data()
    }

    pub(super) fn decoded(frame: BoxVideoFrame) -> Option<Self> {
        if !valid_size(frame.buffer.width(), frame.buffer.height()) {
            return None;
        }
        let mut buffer = frame.buffer.to_i420();
        if let Some(rotated) = rotate(&buffer, frame.rotation) {
            buffer = rotated;
        }
        Some(Self::new(buffer, frame.timestamp_us))
    }

    pub(super) fn bounded(mut self, max_width: u32, max_height: u32) -> Self {
        let (max_width, max_height) = if self.width < self.height {
            (max_height, max_width)
        } else {
            (max_width, max_height)
        };
        let scale = (f64::from(max_width) / f64::from(self.width))
            .min(f64::from(max_height) / f64::from(self.height));
        if scale >= 1.0 {
            return self;
        }
        let width = (f64::from(self.width) * scale).floor().max(1.0) as i32;
        let height = (f64::from(self.height) * scale).floor().max(1.0) as i32;
        Self::new(self.buffer.scale(width, height), self.timestamp_us)
    }
}

pub(super) struct PublishFrame(pub Arc<ShareFrame>);

impl AsRef<dyn VideoBuffer> for PublishFrame {
    fn as_ref(&self) -> &(dyn VideoBuffer + 'static) {
        self.0.buffer.as_ref()
    }
}

fn valid_size(width: u32, height: u32) -> bool {
    (1..=MAX_DIMENSION).contains(&width)
        && (1..=MAX_DIMENSION).contains(&height)
        && width * height <= MAX_PIXELS
}

fn rotate(buffer: &I420Buffer, rotation: VideoRotation) -> Option<I420Buffer> {
    use VideoRotation::*;
    let width = buffer.width();
    let height = buffer.height();
    let (out_width, out_height) = match rotation {
        VideoRotation0 => return None,
        VideoRotation180 => (width, height),
        VideoRotation90 | VideoRotation270 => (height, width),
    };

    let mut rotated = I420Buffer::new(out_width, out_height);
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    if rotate_libyuv(buffer, &mut rotated, rotation) {
        return Some(rotated);
    }

    let (y, u, v) = buffer.data();
    let (out_y, out_u, out_v) = rotated.data_mut();
    let (sy, su, sv) = buffer.strides();
    for (data, stride, out, width, height) in [
        (y, sy, out_y, width, height),
        (u, su, out_u, width.div_ceil(2), height.div_ceil(2)),
        (v, sv, out_v, width.div_ceil(2), height.div_ceil(2)),
    ] {
        let out_width = if rotation == VideoRotation180 {
            width
        } else {
            height
        };
        for row in 0..height {
            for col in 0..width {
                let (x, y) = match rotation {
                    VideoRotation90 => (height - 1 - row, col),
                    VideoRotation180 => (width - 1 - col, height - 1 - row),
                    VideoRotation270 => (row, width - 1 - col),
                    VideoRotation0 => unreachable!(),
                };
                out[(y * out_width + x) as usize] = data[(row * stride + col) as usize];
            }
        }
    }
    Some(rotated)
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn rotate_libyuv(source: &I420Buffer, target: &mut I420Buffer, rotation: VideoRotation) -> bool {
    unsafe extern "C" {
        #[link_name = "I420Rotate"]
        fn i420_rotate(
            source_y: *const u8,
            source_stride_y: i32,
            source_u: *const u8,
            source_stride_u: i32,
            source_v: *const u8,
            source_stride_v: i32,
            target_y: *mut u8,
            target_stride_y: i32,
            target_u: *mut u8,
            target_stride_u: i32,
            target_v: *mut u8,
            target_stride_v: i32,
            width: i32,
            height: i32,
            rotation: i32,
        ) -> i32;
    }

    let (width, height) = (source.width(), source.height());
    // libyuv's 180-degree path allocates scratch rows without reporting allocation failure.
    if !matches!(
        rotation,
        VideoRotation::VideoRotation90 | VideoRotation::VideoRotation270
    ) || !valid_size(width, height)
        || (target.width(), target.height()) != (height, width)
    {
        return false;
    }
    let (sy, su, sv) = source.strides();
    let (y, u, v) = source.data();
    let chroma_width = width.div_ceil(2);
    let chroma_height = height.div_ceil(2);
    if ![
        (y, sy, width, height),
        (u, su, chroma_width, chroma_height),
        (v, sv, chroma_width, chroma_height),
    ]
    .into_iter()
    .all(|(plane, stride, width, height)| {
        stride >= width
            && stride <= i32::MAX as u32 / height
            && plane.len() >= (stride * height) as usize
    }) {
        return false;
    }

    let (dy, du, dv) = target.strides();
    if (dy, du, dv) != (height, chroma_height, chroma_height) {
        return false;
    }
    let (out_y, out_u, out_v) = target.data_mut();
    // SAFETY: The source planes cover every row at their strides. The target is
    // a separate, tightly packed I420 buffer of the verified rotated dimensions.
    // The synchronous quarter-turn routine writes into those output planes.
    unsafe {
        i420_rotate(
            y.as_ptr(),
            sy as i32,
            u.as_ptr(),
            su as i32,
            v.as_ptr(),
            sv as i32,
            out_y.as_mut_ptr(),
            dy as i32,
            out_u.as_mut_ptr(),
            du as i32,
            out_v.as_mut_ptr(),
            dv as i32,
            width as i32,
            height as i32,
            rotation as i32,
        ) == 0
    }
}

#[derive(Default)]
struct CaptureVideo {
    latest: Option<ShareFrame>,
    tail_rows: Vec<u8>,
}

struct CaptureState {
    video: Mutex<CaptureVideo>,
    audio: Mutex<VecDeque<i16>>,
    closed: AtomicBool,
    lost: AtomicBool,
    audio_unavailable: AtomicBool,
}

#[derive(Clone)]
pub struct ScreenCaptureSink(Arc<CaptureState>);

pub struct ScreenCapture(Arc<CaptureState>);

pub fn screen_capture() -> (ScreenCaptureSink, ScreenCapture) {
    let state = Arc::new(CaptureState {
        video: Mutex::new(CaptureVideo::default()),
        audio: Mutex::new(VecDeque::with_capacity(AUDIO_CAPACITY)),
        closed: AtomicBool::new(false),
        lost: AtomicBool::new(false),
        audio_unavailable: AtomicBool::new(false),
    });
    (ScreenCaptureSink(state.clone()), ScreenCapture(state))
}

impl ScreenCaptureSink {
    pub fn bgra(&self, width: u32, height: u32, stride: usize, pixels: &[u8]) {
        self.video(width, height, stride, pixels, false);
    }

    pub fn rgba(&self, width: u32, height: u32, stride: usize, pixels: &[u8]) {
        self.video(width, height, stride, pixels, true);
    }

    fn video(&self, width: u32, height: u32, stride: usize, pixels: &[u8], rgba: bool) {
        if self.0.closed.load(Relaxed) || self.0.lost.load(Relaxed) || !valid_size(width, height) {
            return;
        }
        let row = width as usize * 4;
        let rows = height as usize;
        if stride < row || stride > i32::MAX as usize / rows {
            return;
        }
        if pixels.len() < stride * (rows - 1) + row {
            return;
        }
        let Ok(mut video) = self.0.video.try_lock() else {
            return;
        };
        let mut buffer = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = buffer.strides();
        let (y, u, v) = buffer.data_mut();
        // libyuv names packed formats by the little-endian word, not byte order.
        let to_i420 = if rgba { abgr_to_i420 } else { argb_to_i420 };
        let convert = |pixels: &[u8],
                       stride: usize,
                       rows: usize,
                       (y, u, v): (&mut [u8], &mut [u8], &mut [u8])| {
            to_i420(
                pixels,
                stride as u32,
                y,
                stride_y,
                u,
                stride_u,
                v,
                stride_v,
                width as i32,
                rows as i32,
            );
        };
        if pixels.len() >= stride * rows {
            convert(pixels, stride, rows, (y, u, v));
        } else {
            // The wrapper requires the last row's padding. Split between chroma pairs
            // so that only the last one or two rows need a packed stride.
            let tail_rows = 2 - rows % 2;
            let prefix_rows = rows - tail_rows;
            let (prefix, tail) = pixels.split_at(prefix_rows * stride);
            let (y_prefix, y_tail) = y.split_at_mut(prefix_rows * stride_y as usize);
            let (u_prefix, u_tail) = u.split_at_mut(prefix_rows / 2 * stride_u as usize);
            let (v_prefix, v_tail) = v.split_at_mut(prefix_rows / 2 * stride_v as usize);
            if prefix_rows != 0 {
                convert(prefix, stride, prefix_rows, (y_prefix, u_prefix, v_prefix));
            }
            let tail = if tail_rows == 2 {
                let scratch = &mut video.tail_rows;
                scratch.clear();
                scratch.reserve_exact(2 * row);
                scratch.extend_from_slice(&tail[..row]);
                scratch.extend_from_slice(&tail[stride..stride + row]);
                scratch.as_slice()
            } else {
                &tail[..row]
            };
            convert(tail, row, tail_rows, (y_tail, u_tail, v_tail));
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |time| time.as_micros() as i64);
        video.latest = Some(ShareFrame::new(buffer, timestamp));
    }

    pub fn stereo(&self, pcm: &[i16]) {
        if self.0.closed.load(Relaxed)
            || self.0.lost.load(Relaxed)
            || self.0.audio_unavailable.load(Relaxed)
            || !pcm.len().is_multiple_of(2)
        {
            return;
        }
        let Ok(mut audio) = self.0.audio.try_lock() else {
            return;
        };
        let pcm = &pcm[pcm.len().saturating_sub(AUDIO_CAPACITY)..];
        let overflow = (audio.len() + pcm.len()).saturating_sub(AUDIO_CAPACITY);
        audio.drain(..overflow);
        audio.extend(pcm);
    }

    pub fn source_lost(&self) {
        self.0.lost.store(true, Relaxed);
    }

    pub fn audio_unavailable(&self) {
        self.0.audio_unavailable.store(true, Relaxed);
    }
}

impl ScreenCapture {
    pub(super) fn video(&self) -> Option<ShareFrame> {
        self.0.video.try_lock().ok()?.latest.take()
    }

    pub(super) fn stereo(&self) -> Option<StereoBlock> {
        let mut audio = self.0.audio.try_lock().ok()?;
        if audio.len() < 960 {
            return None;
        }
        Some(std::array::from_fn(|_| {
            audio.pop_front().expect("complete stereo block")
        }))
    }

    pub(super) fn source_lost(&self) -> bool {
        self.0.lost.load(Relaxed)
    }

    pub(super) fn audio_unavailable(&self) -> bool {
        self.0.audio_unavailable.load(Relaxed)
    }
}

impl Drop for ScreenCapture {
    fn drop(&mut self) {
        self.0.closed.store(true, Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotated_i420_preserves_visible_samples_with_odd_dimensions_and_distinct_strides() {
        use VideoRotation::*;

        for (width, height) in [
            (1_u32, 1_u32),
            (1, 9),
            (8, 1),
            (4, 2),
            (5, 3),
            (31, 16),
            (66, 39),
        ] {
            let cw = width.div_ceil(2);
            let ch = height.div_ceil(2);
            let mut input = I420Buffer::with_strides(width, height, width + 5, cw + 3, cw + 11);
            let (sy, su, sv) = input.strides();
            let (y, u, v) = input.data_mut();
            for (index, (bytes, stride, size)) in [
                (y, sy, (width, height)),
                (u, su, (cw, ch)),
                (v, sv, (cw, ch)),
            ]
            .into_iter()
            .enumerate()
            {
                bytes.fill(239);
                for row in 0..size.1 {
                    for col in 0..size.0 {
                        bytes[(row * stride + col) as usize] =
                            (row as usize * 131 + col as usize * 13 + index * 83) as u8;
                    }
                }
            }

            assert!(rotate(&input, VideoRotation0).is_none());
            for rotation in [VideoRotation90, VideoRotation180, VideoRotation270] {
                let result = rotate(&input, rotation).unwrap();
                let (dy, du, dv) = result.strides();
                let (y, u, v) = input.data();
                let (out_y, out_u, out_v) = result.data();
                for (source, target, src_stride, dst_stride, w, h) in [
                    (y, out_y, sy, dy, width, height),
                    (u, out_u, su, du, cw, ch),
                    (v, out_v, sv, dv, cw, ch),
                ] {
                    let (dst_w, dst_h) = if rotation == VideoRotation180 {
                        (w, h)
                    } else {
                        (h, w)
                    };
                    assert_eq!(target.len(), (dst_stride * dst_h) as usize);
                    for row in 0..dst_h {
                        for col in 0..dst_w {
                            let (x, y) = match rotation {
                                VideoRotation90 => (row, h - 1 - col),
                                VideoRotation180 => (w - 1 - col, h - 1 - row),
                                VideoRotation270 => (w - 1 - row, col),
                                VideoRotation0 => unreachable!(),
                            };
                            assert_eq!(
                                target[(row * dst_stride + col) as usize],
                                source[(y * src_stride + x) as usize],
                                "{width}x{height}, {rotation:?}, ({col}, {row})"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn latest_capture_converts_both_formats_and_partial_final_stride() {
        let (sink, capture) = screen_capture();
        sink.bgra(1, 1, 4, &[0, 0, 255, 255]);
        let first = capture.video().unwrap();
        sink.rgba(1, 2, 8, &[255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
        sink.rgba(1, 2, 8, &[255, 0, 0, 255]);
        let latest = capture.video().unwrap();
        assert_eq!((latest.width, latest.height), (1, 2));
        assert!(latest.sequence > first.sequence);
        assert_eq!(latest.planes().0, &[first.planes().0[0]; 2]);
        assert_eq!(latest.planes().1, first.planes().1);
        assert_eq!(latest.planes().2, first.planes().2);
        assert!(capture.video().is_none());
    }

    #[test]
    fn short_final_rows_match_full_stride_for_both_pixel_orders() {
        let (sink, capture) = screen_capture();
        let formats = [ScreenCaptureSink::bgra, ScreenCaptureSink::rgba];
        for (width, height) in [(1, 1), (1, 2), (7, 3), (16, 4), (33, 5), (64, 6)] {
            let row = width as usize * 4;
            let stride = row + 13;
            let full = stride * height as usize;
            let visible = full - (stride - row);
            let pixels: Vec<_> = (0..full)
                .map(|index| (index * 31 + index / stride * 83) as u8)
                .collect();
            for send in formats {
                send(&sink, width, height, stride, &pixels);
                let expected = capture.video().unwrap();
                for end in [visible, visible + 3] {
                    send(&sink, width, height, stride, &pixels[..end]);
                    let short = capture.video().unwrap();
                    assert_eq!(short.planes(), expected.planes(), "{width}x{height}, {end}");
                }
                send(&sink, width, height, stride, &pixels[..visible - 1]);
                assert!(capture.video().is_none());
            }
        }
    }

    #[test]
    fn stereo_capture_is_bounded_and_reassembles_pairs() {
        let (sink, capture) = screen_capture();
        sink.stereo(&[3; 20]);
        sink.stereo(&[1; 939]);
        assert!(capture.stereo().is_none());
        sink.stereo(&[4; 940]);
        let block = capture.stereo().unwrap();
        assert_eq!(block[..20], [3; 20]);
        assert_eq!(block[20..], [4; 940]);
        let pcm = vec![8; AUDIO_CAPACITY + 200];
        sink.stereo(&pcm);
        for _ in 0..8 {
            assert_eq!(capture.stereo().unwrap(), [8; 960]);
        }
        assert!(capture.stereo().is_none());
    }

    #[test]
    fn capture_can_be_stopped_and_keeps_portrait_aspect() {
        let (sink, capture) = screen_capture();
        let bytes = vec![0; 12 * 24 * 4];
        sink.bgra(12, 24, 12 * 4, &bytes);
        let frame = capture.video().unwrap().bounded(12, 8);
        assert_eq!((frame.width, frame.height), (6, 12));
        assert!(!capture.source_lost());
        sink.source_lost();
        assert!(capture.source_lost());
        sink.bgra(12, 24, 12 * 4, &bytes);
        assert!(capture.video().is_none());
    }
}
