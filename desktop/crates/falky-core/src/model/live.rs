use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use super::{AttachmentId, EventId, Message, Participant, RoomId, SignInRequest, VisitorColour};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveEvent {
    pub v: u32,
    pub event_id: EventId,
    pub room_id: Option<RoomId>,
    pub timestamp: DateTime<Utc>,
    pub payload: LivePayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LivePayload {
    MessageCreated(Message),
    MessageUpdated(Message),
    RoomChanged(RoomChange),
    OccupancyChanged(OccupancyChange),
    VisitorColourChanged(VisitorColour),
    AttachmentsExpired(AttachmentsExpired),
    SignInStateChanged(SignInRequest),
    AccessRevoked(AccessRevoked),
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct RoomChange {
    pub id: RoomId,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OccupancyChange {
    pub room_id: RoomId,
    pub occupancy: Vec<Participant>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentsExpired {
    pub attachment_ids: Vec<AttachmentId>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct AccessRevoked {
    pub reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    v: u32,
    #[serde(rename = "type")]
    kind: String,
    event_id: EventId,
    room_id: Option<RoomId>,
    timestamp: DateTime<Utc>,
    payload: Value,
}

impl<'de> Deserialize<'de> for LiveEvent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let Envelope {
            v,
            kind,
            event_id,
            room_id,
            timestamp,
            payload,
        } = Envelope::deserialize(deserializer)?;
        let payload = if v != 1 {
            LivePayload::Unknown
        } else {
            match kind.as_str() {
                "message.created" => {
                    serde_json::from_value(payload).map(LivePayload::MessageCreated)
                }
                "message.updated" => {
                    serde_json::from_value(payload).map(LivePayload::MessageUpdated)
                }
                "room.changed" => serde_json::from_value(payload).map(LivePayload::RoomChanged),
                "occupancy.changed" => {
                    serde_json::from_value(payload).map(LivePayload::OccupancyChanged)
                }
                "visitor.colour.changed" => {
                    serde_json::from_value(payload).map(LivePayload::VisitorColourChanged)
                }
                "attachments.expired" => {
                    serde_json::from_value(payload).map(LivePayload::AttachmentsExpired)
                }
                "account.signin.state_changed" => {
                    serde_json::from_value(payload).map(LivePayload::SignInStateChanged)
                }
                "access.revoked" => serde_json::from_value(payload).map(LivePayload::AccessRevoked),
                _ => Ok(LivePayload::Unknown),
            }
            .map_err(serde::de::Error::custom)?
        };
        Ok(Self {
            v,
            event_id,
            room_id,
            timestamp,
            payload,
        })
    }
}
