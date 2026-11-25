use std::{
    io::Cursor,
    num::NonZeroUsize,
    path::{Path, PathBuf},
};

use bytes::Bytes;
use falky_core::{
    ApiError,
    attachments::{AttachmentsApi, Content, Limits},
    model::{Attachment, AttachmentId},
};
use iced::widget::image::Handle;
use image::{ImageFormat, ImageReader, Limits as DecodeLimits, RgbaImage};
use lru::LruCache;
use reqwest::header::HeaderValue;

const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const CACHE_ENTRIES: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputError {
    NoImage,
    TooLarge,
    Invalid,
}

#[derive(Clone, Debug)]
pub struct Input {
    pub name: String,
    pub bytes: Bytes,
    pub preview: Handle,
}

impl Input {
    fn new(name: String, bytes: Vec<u8>, limit: usize) -> Result<Self, InputError> {
        if bytes.len() > limit {
            return Err(InputError::TooLarge);
        }
        if !matches!(
            image::guess_format(&bytes),
            Ok(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif)
        ) {
            return Err(InputError::NoImage);
        }
        let preview = decode(&bytes, 160, 16_384)
            .map_err(|_| InputError::Invalid)?
            .handle;
        Ok(Self {
            name,
            bytes: Bytes::from(bytes),
            preview,
        })
    }
}

pub async fn load_files(
    paths: Vec<PathBuf>,
    count: usize,
    limits: Limits,
) -> Vec<Result<Input, InputError>> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .take(count)
            .map(|path| load_file(&path, limits.input_bytes))
            .collect()
    })
    .await
    .unwrap_or_else(|_| vec![Err(InputError::Invalid)])
}

fn load_file(path: &Path, limit: usize) -> Result<Input, InputError> {
    use std::io::Read;

    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.len() <= 255)
        .unwrap_or("image");
    let metadata = std::fs::metadata(path).map_err(|_| InputError::Invalid)?;
    if !metadata.is_file() {
        return Err(InputError::NoImage);
    }
    if metadata.len() > limit as u64 {
        return Err(InputError::TooLarge);
    }
    let file = std::fs::File::open(path).map_err(|_| InputError::Invalid)?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| InputError::Invalid)?;
    Input::new(name.into(), bytes, limit)
}

pub async fn paste(limit: usize) -> ClipboardContents {
    tokio::task::spawn_blocking(move || {
        let Ok(mut clipboard) = arboard::Clipboard::new() else {
            return ClipboardContents::Unavailable;
        };
        match clipboard.get_image() {
            Ok(data) => ClipboardContents::Image(encode_clipboard_image(data, limit)),
            Err(_) => clipboard
                .get_text()
                .map_or(ClipboardContents::Unavailable, ClipboardContents::Text),
        }
    })
    .await
    .unwrap_or(ClipboardContents::Unavailable)
}

fn encode_clipboard_image(data: arboard::ImageData<'_>, limit: usize) -> Result<Input, InputError> {
    if data.width > 16_384
        || data.height > 16_384
        || data.width.saturating_mul(data.height) > 24_000_000
    {
        return Err(InputError::TooLarge);
    }
    let image = RgbaImage::from_raw(
        data.width as u32,
        data.height as u32,
        data.bytes.into_owned(),
    )
    .ok_or(InputError::Invalid)?;
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| InputError::Invalid)?;
    Input::new("image.png".into(), output.into_inner(), limit)
}

#[derive(Clone, Debug)]
pub enum ClipboardContents {
    Text(String),
    Image(Result<Input, InputError>),
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Size {
    Thumbnail,
    Viewer,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Key(pub AttachmentId, pub Size);

#[derive(Clone, Debug)]
pub struct Decoded {
    pub handle: Handle,
    bytes: usize,
}

#[derive(Clone, Debug)]
pub struct Image {
    pub decoded: Decoded,
    pub etag: Option<HeaderValue>,
}

#[cfg(test)]
pub(super) fn test_image() -> Image {
    Image {
        decoded: Decoded {
            handle: Handle::from_rgba(1, 1, vec![0, 0, 0, 255]),
            bytes: 4,
        },
        etag: None,
    }
}

#[derive(Clone, Debug)]
pub enum Fetched {
    Unchanged,
    Image(Image),
    Expired,
}

pub async fn fetch(
    api: AttachmentsApi,
    key: Key,
    etag: Option<HeaderValue>,
    limit: usize,
) -> Result<Fetched, ApiError> {
    match api.image(&key.0, etag, limit).await {
        Ok(Content::Unchanged) => Ok(Fetched::Unchanged),
        Ok(Content::Image { bytes, etag }) => {
            let edge = match key.1 {
                Size::Thumbnail => 480,
                Size::Viewer => 1920,
            };
            let decoded = tokio::task::spawn_blocking(move || decode(&bytes, edge, 16_384))
                .await
                .map_err(|_| ApiError::InvalidResponse)??;
            Ok(Fetched::Image(Image { decoded, etag }))
        }
        Err(error)
            if matches!(
                error.status(),
                Some(reqwest::StatusCode::GONE | reqwest::StatusCode::NOT_FOUND)
            ) =>
        {
            Ok(Fetched::Expired)
        }
        Err(error) => Err(error),
    }
}

fn decode(data: &[u8], edge: u32, maximum_dimension: u32) -> Result<Decoded, ApiError> {
    let format = image::guess_format(data).map_err(|_| ApiError::InvalidResponse)?;
    let (width, height) = ImageReader::with_format(Cursor::new(data), format)
        .into_dimensions()
        .map_err(|_| ApiError::InvalidResponse)?;
    if u64::from(width) * u64::from(height) > 24_000_000 {
        return Err(ApiError::InvalidResponse);
    }
    let mut reader = ImageReader::with_format(Cursor::new(data), format);
    let mut limits = DecodeLimits::default();
    limits.max_image_width = Some(maximum_dimension);
    limits.max_image_height = Some(maximum_dimension);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|_| ApiError::InvalidResponse)?;
    let small = if image.width() > edge || image.height() > edge {
        image.thumbnail(edge, edge)
    } else {
        image
    };
    let width = small.width();
    let height = small.height();
    let rgba = small.into_rgba8().into_raw();
    Ok(Decoded {
        bytes: rgba.len(),
        handle: Handle::from_rgba(width, height, rgba),
    })
}

pub struct Cache {
    entries: LruCache<Key, Image>,
    bytes: usize,
}

impl Default for Cache {
    fn default() -> Self {
        Self {
            entries: LruCache::new(NonZeroUsize::new(CACHE_ENTRIES).unwrap()),
            bytes: 0,
        }
    }
}

impl Cache {
    pub fn peek(&self, key: &Key) -> Option<&Image> {
        self.entries.peek(key)
    }

    pub fn etag(&mut self, key: &Key) -> Option<HeaderValue> {
        self.entries.get(key)?.etag.clone()
    }

    pub fn remove(&mut self, key: &Key) {
        if let Some(image) = self.entries.pop(key) {
            self.bytes -= image.decoded.bytes;
        }
    }

    pub fn insert(&mut self, key: Key, image: Image) {
        self.remove(&key);
        if image.decoded.bytes > MEMORY_LIMIT {
            return;
        }
        while self.entries.len() == CACHE_ENTRIES || self.bytes + image.decoded.bytes > MEMORY_LIMIT
        {
            if let Some((_, removed)) = self.entries.pop_lru() {
                self.bytes -= removed.decoded.bytes;
            }
        }
        self.bytes += image.decoded.bytes;
        self.entries.put(key, image);
    }
}

pub fn ratio(attachment: &Attachment) -> f32 {
    if attachment.width == 0 || attachment.height == 0 {
        4.0 / 3.0
    } else {
        (attachment.width as f32 / attachment.height as f32).clamp(0.6, 2.2)
    }
}

pub fn gallery_size(attachments: &[&Attachment], width: f32) -> (f32, f32) {
    match attachments {
        [] => (0.0, 0.0),
        [image] => {
            let ratio = ratio(image);
            let height = (width / ratio).min(320.0);
            (height * ratio, height)
        }
        [_, _] => (width, width / (2.0 / 1.15)),
        [_, _, _] => (width, width / (3.0 / 2.0)),
        _ => (width, width),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(width: u32, height: u32) -> Attachment {
        Attachment {
            id: "image".into(),
            filename: "image.webp".into(),
            content_type: "image/webp".into(),
            size: 100,
            inline: true,
            width,
            height,
            availability: falky_core::model::AttachmentAvailability::Posted,
            expires_at: None,
            content_url: String::new(),
        }
    }

    #[test]
    fn gallery_formats_use_server_sizes_and_a_single_height_cap() {
        let portrait = attachment(1, 9);
        let panoramic = attachment(9, 1);
        let missing = attachment(0, 0);
        assert_eq!(ratio(&portrait), 0.6);
        assert_eq!(ratio(&panoramic), 2.2);
        assert_eq!(ratio(&missing), 4.0 / 3.0);
        assert_eq!(gallery_size(&[&portrait], 900.0).1, 320.0);
        assert_eq!(
            gallery_size(&[&portrait, &panoramic], 230.0),
            (230.0, 132.25)
        );
        assert_eq!(
            gallery_size(&[&portrait, &panoramic, &missing], 240.0),
            (240.0, 160.0)
        );
        assert_eq!(
            gallery_size(&[&portrait, &panoramic, &missing, &missing], 240.0),
            (240.0, 240.0)
        );
    }

    #[test]
    fn decoded_cache_evicts_least_recent_and_counts_memory() {
        let mut cache = Cache::default();
        let picture = Image {
            decoded: Decoded {
                handle: Handle::from_rgba(1, 1, vec![0, 0, 0, 255]),
                bytes: MEMORY_LIMIT / 2,
            },
            etag: Some(HeaderValue::from_static("fixture")),
        };
        let key = |id: &str| Key(id.into(), Size::Viewer);
        cache.insert(key("first"), picture.clone());
        cache.insert(key("second"), picture.clone());
        assert!(cache.etag(&key("first")).is_some());
        cache.insert(key("third"), picture);
        assert!(cache.peek(&key("second")).is_none());
        assert!(cache.peek(&key("first")).is_some());
        assert!(cache.peek(&key("third")).is_some());
        assert_eq!(cache.bytes, MEMORY_LIMIT);
    }

    #[test]
    fn image_input_rejects_nonimages_and_over_limit_without_a_decode() {
        assert!(matches!(
            Input::new("x.txt".into(), vec![1, 2, 3], 99),
            Err(InputError::NoImage)
        ));
        assert!(matches!(
            Input::new("x.png".into(), vec![0; 3], 2),
            Err(InputError::TooLarge)
        ));
    }
}
