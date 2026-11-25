use bytes::{Bytes, BytesMut};
use reqwest::{
    StatusCode,
    header::{CONTENT_TYPE, ETAG, HeaderValue},
    multipart::{Form, Part},
};

use crate::{
    ApiClient, ApiError,
    model::{Attachment, AttachmentAvailability, AttachmentId, AttachmentLimits, RoomId},
    transport::Method,
};

pub const MAX_IMAGES: usize = 4;
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Limits {
    pub count: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            count: MAX_IMAGES,
            input_bytes: MAX_FILE_BYTES,
            output_bytes: MAX_OUTPUT_BYTES,
        }
    }
}

impl From<AttachmentLimits> for Limits {
    fn from(value: AttachmentLimits) -> Self {
        Self {
            count: value.max_attachments.min(MAX_IMAGES as u64) as usize,
            input_bytes: value.max_file_bytes.min(MAX_FILE_BYTES as u64) as usize,
            output_bytes: value.max_output_bytes.min(MAX_OUTPUT_BYTES as u64) as usize,
        }
    }
}

#[derive(Clone)]
pub struct AttachmentsApi(pub ApiClient);

#[derive(Clone, Debug)]
pub enum Content {
    Unchanged,
    Image {
        bytes: Bytes,
        etag: Option<HeaderValue>,
    },
}

impl AttachmentsApi {
    pub async fn limits(&self) -> Result<Limits, ApiError> {
        self.0
            .json::<AttachmentLimits>(
                self.0
                    .request(Method::GET, &["api", "attachments", "limits"]),
            )
            .await
            .map(Limits::from)
    }

    pub async fn metadata(&self, id: &AttachmentId) -> Result<Attachment, ApiError> {
        self.0
            .json(
                self.0
                    .request(Method::GET, &["api", "attachments", id.as_str()]),
            )
            .await
    }

    pub async fn cancel(&self, id: &AttachmentId) -> Result<(), ApiError> {
        self.0
            .send(
                self.0
                    .request(Method::DELETE, &["api", "attachments", id.as_str()]),
            )
            .await
            .map(|_| ())
    }

    pub async fn upload(
        &self,
        room: &RoomId,
        filename: String,
        bytes: Bytes,
    ) -> Result<Attachment, ApiError> {
        if bytes.is_empty() || bytes.len() > MAX_FILE_BYTES {
            return Err(ApiError::InvalidRequest);
        }
        let form = Form::new().part(
            "file",
            Part::stream_with_length(bytes.clone(), bytes.len() as u64).file_name(filename),
        );
        self.0
            .json(
                self.0
                    .request(
                        Method::POST,
                        &["api", "rooms", room.as_str(), "attachments"],
                    )
                    .multipart(form),
            )
            .await
    }

    pub async fn image(
        &self,
        id: &AttachmentId,
        etag: Option<HeaderValue>,
        maximum: usize,
    ) -> Result<Content, ApiError> {
        let mut request = self
            .0
            .request(Method::GET, &["api", "attachments", id.as_str(), "content"]);
        let conditional = etag.is_some();
        if let Some(etag) = etag {
            request = request.if_none_match(etag);
        }
        let mut response = self.0.send(request).await?;
        if response.status() == StatusCode::NOT_MODIFIED && conditional {
            return Ok(Content::Unchanged);
        }

        let maximum = maximum.min(MAX_OUTPUT_BYTES);
        if response.status() != StatusCode::OK
            || response
                .content_length()
                .is_some_and(|length| length > maximum as u64)
            || !response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(is_image)
        {
            return Err(ApiError::InvalidResponse);
        }
        let etag = response.headers().get(ETAG).cloned();
        let mut bytes = BytesMut::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ApiError::Transport)? {
            if bytes.len().saturating_add(chunk.len()) > maximum {
                return Err(ApiError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(Content::Image {
            bytes: bytes.freeze(),
            etag,
        })
    }
}

pub fn is_image(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

pub fn is_available(attachment: &Attachment) -> bool {
    matches!(
        attachment.availability,
        AttachmentAvailability::Ready | AttachmentAvailability::Posted
    )
}
