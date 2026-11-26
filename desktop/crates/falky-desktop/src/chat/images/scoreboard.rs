use std::borrow::Cow;

use super::*;
use crate::perf;

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_clipboard() {
    let (width, height) = (3840, 2160);
    let pixels = perf::packed_pixels(width, height, width * 4);
    let encoded = perf::repeat_with(
        "chat.clipboard_4k",
        15,
        || pixels.clone(),
        |buffer| {
            encode_clipboard_image(
                arboard::ImageData {
                    width,
                    height,
                    bytes: Cow::Owned(buffer),
                },
                64 * 1024 * 1024,
            )
            .expect("valid clipboard bitmap")
        },
    );
    let Handle::Rgba {
        width,
        height,
        pixels,
        ..
    } = encoded.preview
    else {
        panic!("expected RGBA clipboard preview");
    };
    perf::golden(
        "chat.clipboard_4k",
        &[
            encoded.name.as_bytes(),
            encoded.bytes.as_ref(),
            &width.to_le_bytes(),
            &height.to_le_bytes(),
            pixels.as_ref(),
        ],
    );
}
