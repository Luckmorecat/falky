mod live;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt::{self, Display, Formatter};

use crate::transport::Origin;

pub use live::{
    AccessRevoked, AttachmentsExpired, LiveEvent, LivePayload, OccupancyChange, RoomChange,
};

macro_rules! identifier {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                self.as_str()
            }
        }

        impl std::borrow::Borrow<str> for $name {
            fn borrow(&self) -> &str {
                self.as_str()
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
                formatter.write_str(self.as_str())
            }
        }
    )+};
}

identifier!(
    AttachmentId,
    ConnectionId,
    EventId,
    MessageId,
    RequestKey,
    RoomId,
    SignInRequestId,
    VisitorId,
);

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("[redacted]")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PaletteName {
    Sky,
    Apricot,
    Lagoon,
    Rose,
    Violet,
    Amber,
    Moss,
    Coral,
    Indigo,
    Plum,
    Sunset,
    Aurora,
    Lime,
    Clay,
    Ocean,
    Ruby,
}

impl PaletteName {
    pub const ALL: [Self; 16] = [
        Self::Sky,
        Self::Apricot,
        Self::Lagoon,
        Self::Rose,
        Self::Violet,
        Self::Amber,
        Self::Moss,
        Self::Coral,
        Self::Indigo,
        Self::Plum,
        Self::Sunset,
        Self::Aurora,
        Self::Lime,
        Self::Clay,
        Self::Ocean,
        Self::Ruby,
    ];
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisitorColour {
    pub visitor_id: VisitorId,
    pub palette: PaletteName,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Visitor {
    pub id: VisitorId,
    pub name: String,
    pub name_taken: bool,
    pub colour: VisitorColour,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Guest,
    Account,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSession {
    pub visitor: Visitor,
    pub kind: SessionKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct SessionGeneration(pub u64);

/// Each login, origin change, or revocation retires the previous generation.
/// Callers discard its client and ignore outstanding results carrying that scope.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SessionScope {
    pub origin: Origin,
    pub generation: SessionGeneration,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct ReconnectGeneration(pub u64);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct LiveScope {
    pub session: SessionScope,
    pub generation: ReconnectGeneration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconnectSnapshot {
    pub scope: LiveScope,
    pub session: AccountSession,
    pub rooms: Vec<Room>,
    pub colours: Vec<VisitorColour>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveUpdate {
    pub scope: LiveScope,
    pub event: LiveEvent,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SignInKind {
    Link,
    Qr,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SignInState {
    Pending,
    Approved,
    Consumed,
    Denied,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInLocation {
    pub country_code: Option<String>,
    pub city: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInRequest {
    pub id: SignInRequestId,
    #[serde(rename = "type")]
    pub kind: SignInKind,
    pub state: SignInState,
    pub link_id: Option<String>,
    pub version: i64,
    pub requester_ip: Option<String>,
    pub requester_location: Option<SignInLocation>,
    pub requester_user_agent: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub approved_at: Option<DateTime<Utc>>,
    pub consumed_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SignInBegin {
    pub request: SignInRequest,
    pub code: Option<Secret>,
    pub token: Option<Secret>,
    pub url: Option<Secret>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub connection_id: ConnectionId,
    pub visitor_id: VisitorId,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Room {
    pub id: RoomId,
    pub name: String,
    pub occupancy: Vec<Participant>,
}

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCredentials {
    pub grant_id: ConnectionId,
    pub url: String,
    pub token: Secret,
}

impl fmt::Debug for VoiceCredentials {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VoiceCredentials")
            .field("grant_id", &self.grant_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentAvailability {
    Ready,
    Posted,
    Expired,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: AttachmentId,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub inline: bool,
    pub width: u32,
    pub height: u32,
    pub availability: AttachmentAvailability,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    pub content_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentLimits {
    pub max_file_bytes: u64,
    pub max_output_bytes: u64,
    pub staging_bytes: u64,
    pub posted_bytes: u64,
    pub max_attachments: u64,
    pub max_pending: u64,
    pub max_upload_streams: u64,
    pub max_pixels: u64,
    pub max_edge: u64,
    pub max_dimension: u64,
    pub draft_ttl_seconds: u64,
    pub process_timeout_seconds: u64,
    pub upload_timeout_seconds: u64,
    pub upload_burst: u64,
    pub upload_refill_seconds: u64,
    pub multipart_overhead_bytes: u64,
    pub multipart_header_bytes: u64,
    pub max_content_streams: u64,
    pub content_timeout_seconds: u64,
    pub max_conversions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: MessageId,
    pub room_id: RoomId,
    pub author_id: VisitorId,
    pub author_name: String,
    pub body: String,
    pub created_at: DateTime<Utc>,
    pub attachments: Vec<Attachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted: bool,
    pub reactions: Vec<ReactionGroup>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReply {
    pub id: MessageId,
    pub author_name: String,
    pub excerpt: String,
    pub deleted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageReaction {
    Up,
    Heart,
    Laugh,
    Wow,
    Fire,
    Clap,
}

impl MessageReaction {
    pub const ALL: [Self; 6] = [
        Self::Up,
        Self::Heart,
        Self::Laugh,
        Self::Wow,
        Self::Fire,
        Self::Clap,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Heart => "heart",
            Self::Laugh => "laugh",
            Self::Wow => "wow",
            Self::Fire => "fire",
            Self::Clap => "clap",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionGroup {
    pub reaction: MessageReaction,
    pub visitor_ids: Vec<VisitorId>,
}
