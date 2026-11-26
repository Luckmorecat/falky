use super::*;
use crate::perf;

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_capture() {
    for (label, width, height) in [("1080p", 1920, 1080), ("4k", 3840, 2160)] {
        let stride = width as usize * 4 + 64;
        let pixels = perf::packed_pixels(width as usize, height as usize, stride);
        let short = &pixels[..stride * (height as usize - 1) + width as usize * 4];
        for (format, rgba) in [("bgra", false), ("rgba", true)] {
            let name = format!("capture.{label}.{format}");
            let (sink, capture) = screen_capture();
            let convert = |pixels: &[u8]| {
                if rgba {
                    sink.rgba(width, height, stride, pixels);
                } else {
                    sink.bgra(width, height, stride, pixels);
                }
                capture.video().expect("valid capture")
            };
            let converted = perf::repeat(&format!("{name}.convert"), 31, || convert(&pixels));
            hash_frame(&format!("{name}.convert"), &converted.buffer);
            let short_name = format!("{name}.convert_short_stride");
            let short_frame = perf::repeat(&short_name, 31, || convert(short));
            assert_eq!(short_frame.planes(), converted.planes());
            hash_frame(&short_name, &short_frame.buffer);

            let bounded = perf::repeat_with(
                &format!("{name}.bounded"),
                31,
                || convert(&pixels),
                |frame| frame.bounded(1280, 720),
            );
            hash_frame(&format!("{name}.bounded"), &bounded.buffer);

            let incoming = std::hint::black_box(&converted.buffer);
            let rotated = perf::repeat(&format!("{name}.rotate"), 31, || {
                rotate(incoming, VideoRotation::VideoRotation90).expect("rotation")
            });
            hash_frame(&format!("{name}.rotate"), &rotated);
        }
    }
}

fn hash_frame(name: &str, frame: &I420Buffer) {
    let (y, u, v) = frame.data();
    perf::golden(
        name,
        &[
            &frame.width().to_le_bytes(),
            &frame.height().to_le_bytes(),
            y,
            u,
            v,
        ],
    );
}
