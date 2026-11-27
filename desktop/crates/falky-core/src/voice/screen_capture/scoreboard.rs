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

#[cfg(target_os = "linux")]
#[test]
#[ignore = "release scoreboard"]
fn scoreboard_native_video() {
    let Ok(fixture) = std::env::var("FALKY_PERF_NATIVE_VIDEO") else {
        return;
    };
    let output = match fixture.as_str() {
        "decode_rotate" => {
            let mut buffer = I420Buffer::new(3840, 2160);
            let (y, u, v) = buffer.data_mut();
            for (plane, stride) in [(y, 3), (u, 7), (v, 11)] {
                for (index, value) in plane.iter_mut().enumerate() {
                    *value = (index * stride) as u8;
                }
            }
            let frame = BoxVideoFrame::new(VideoRotation::VideoRotation90, Box::new(buffer));
            ShareFrame::decoded(frame).expect("valid 4K decoded frame")
        }
        "pending_replace" => {
            let (width, height) = (2560usize, 1440usize);
            let stride = width * 4;
            let pixels = perf::packed_pixels(width, height, stride);
            let (sink, capture) = screen_capture();
            sink.bgra(width as u32, height as u32, stride, &pixels);
            sink.rgba(width as u32, height as u32, stride, &pixels);
            capture.video().expect("valid replacement capture frame")
        }
        _ => panic!("unknown native video fixture {fixture}"),
    };
    let (pss_anon, vm_hwm) = perf::process_bytes();
    perf::metric(
        &format!("capture.native.{fixture}.pss_anon_bytes"),
        pss_anon,
    );
    perf::metric(&format!("capture.native.{fixture}.vm_hwm_bytes"), vm_hwm);
    hash_frame(&format!("capture.native.{fixture}"), &output.buffer);
}
