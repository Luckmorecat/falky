use super::*;
use crate::{perf, perf_fixture::Picture};

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_software_video() {
    let frame: Arc<dyn PlanarFrame> = Arc::new(Picture::new(1920, 1080, 0));
    let converted = perf::repeat("share.software.convert", 101, || {
        SoftwareFrame::default()
            .handle(&frame)
            .expect("valid software frame")
    });
    let mut cache = SoftwareFrame::default();
    let initial = cache.handle(&frame).unwrap();
    let cached = perf::repeat("share.software.cached", 1001, || {
        cache.handle(&frame).expect("valid cached software frame")
    });
    assert_eq!(initial.id(), cached.id());
    for (name, handle) in [
        ("share.software.convert", converted),
        ("share.software.cached", cached),
    ] {
        let image::Handle::Rgba {
            width,
            height,
            pixels,
            ..
        } = handle
        else {
            panic!("expected RGBA video");
        };
        perf::golden(
            name,
            &[&width.to_le_bytes(), &height.to_le_bytes(), pixels.as_ref()],
        );
    }
}

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_software_replacement() {
    let high: Arc<dyn PlanarFrame> = Arc::new(Picture::new(3840, 2160, 0));
    let low: Arc<dyn PlanarFrame> = Arc::new(Picture::new(1920, 1080, 1));
    let handle = perf::repeat_with(
        "share.software.replacement",
        15,
        || {
            let mut cache = SoftwareFrame::default();
            assert!(cache.handle(&high).is_some());
            cache
        },
        |mut cache| cache.handle(&low).expect("valid software frame"),
    );
    let image::Handle::Rgba {
        width,
        height,
        pixels,
        ..
    } = handle
    else {
        panic!("expected RGBA video");
    };
    perf::golden(
        "share.software.replacement",
        &[&width.to_le_bytes(), &height.to_le_bytes(), pixels.as_ref()],
    );
}

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_software_video_handoff() {
    let mut cache = SoftwareFrame::default();
    let start = perf::live_bytes();
    let previous: Arc<dyn PlanarFrame> = Arc::new(Picture::new(3840, 2160, 0));
    let displayed = cache.handle(&previous).expect("valid software frame");
    drop(previous);
    let retained = perf::live_bytes() - start;

    let current: Arc<dyn PlanarFrame> = Arc::new(Picture::new(1920, 1080, 1));
    let replacement = cache.handle(&current).expect("valid software frame");
    assert_ne!(displayed.id(), replacement.id());
    assert_eq!(cache.handle(&current).unwrap().id(), replacement.id());
    for (name, handle) in [
        ("share.software.handoff.previous", displayed),
        ("share.software.handoff.replacement", replacement),
    ] {
        let image::Handle::Rgba {
            width,
            height,
            pixels,
            ..
        } = handle
        else {
            panic!("expected RGBA video");
        };
        perf::golden(
            name,
            &[&width.to_le_bytes(), &height.to_le_bytes(), pixels.as_ref()],
        );
    }
    perf::metric("share.software.handoff.retained_bytes", retained);
}
