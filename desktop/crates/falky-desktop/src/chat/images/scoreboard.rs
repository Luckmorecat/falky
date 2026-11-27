use std::borrow::Cow;

use super::*;
use crate::perf;

pub(in crate::chat) fn pixels_to_clipboard(
    buffer: Vec<u8>,
    limit: usize,
) -> Result<Input, InputError> {
    encode_clipboard_image(
        arboard::ImageData {
            width: 3840,
            height: 2160,
            bytes: Cow::Owned(buffer),
        },
        limit,
    )
}

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_clipboard() {
    let (width, height) = (3840, 2160);
    let pixels = perf::packed_pixels(width, height, width * 4);
    let encoded = perf::repeat_with(
        "chat.clipboard_4k",
        15,
        || pixels.clone(),
        |buffer| pixels_to_clipboard(buffer, 64 * 1024 * 1024).expect("valid clipboard bitmap"),
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

pub(in crate::chat) fn viewer_image() -> Image {
    cache_image(1920, 1080)
}

fn cache_image(width: u32, height: u32) -> Image {
    let image = RgbaImage::from_pixel(width, height, image::Rgba([53, 81, 104, 255]));
    Image {
        decoded: resize(DynamicImage::ImageRgba8(image), width.max(height)),
        etag: Some(HeaderValue::from_static("\"scoreboard\"")),
    }
}

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_image_cache() {
    let start = perf::live_bytes();
    let mut cache = Cache::default();
    for index in 0..CACHE_ENTRIES {
        cache.insert(
            Key(format!("thumbnail-{index}").into(), Size::Thumbnail),
            cache_image(480, 480),
        );
    }
    cache.insert(Key("viewer".into(), Size::Viewer), viewer_image());
    let retained = perf::live_bytes() - start;
    let accounted = cache.bytes;
    assert_eq!(cache.entries.len(), CACHE_ENTRIES);
    assert!(MEMORY_LIMIT - accounted < 480 * 480 * 4);
    drop(cache);
    perf::metric("chat.image_cache.retained_bytes", retained);
    perf::metric("chat.image_cache.accounted_bytes", accounted);
}

#[test]
#[ignore = "release scoreboard"]
fn scoreboard_viewer_decode() {
    let (width, height) = (1920u32, 1080u32);
    let rgb: Vec<_> = (0..width * height)
        .flat_map(|index| [index as u8, (index / width) as u8, (index / 31) as u8])
        .collect();
    let mut encoded = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut encoded)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    drop(rgb);
    let decoded = perf::repeat("chat.viewer.decode", 15, || {
        decode(&encoded, 1920, 16_384).unwrap()
    });
    let Handle::Rgba {
        width,
        height,
        pixels,
        ..
    } = decoded.handle
    else {
        panic!("expected RGBA viewer image");
    };
    perf::golden(
        "chat.viewer.decode",
        &[&width.to_le_bytes(), &height.to_le_bytes(), pixels.as_ref()],
    );
}
