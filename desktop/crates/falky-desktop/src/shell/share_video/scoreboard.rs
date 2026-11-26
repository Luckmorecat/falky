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
