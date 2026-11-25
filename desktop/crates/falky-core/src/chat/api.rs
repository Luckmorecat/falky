use serde::{Deserialize, Serialize};

use crate::{
    ApiClient, ApiError,
    model::{AttachmentId, Message, MessageId, MessageReaction, RequestKey, RoomId},
    transport::Method,
};

use super::PreviousSync;

pub const PAGE_SIZE: usize = 100;
const EMPTY_ROOM: &str = "00000000000000000000000000";

#[derive(Clone)]
pub struct ChatApi(pub ApiClient);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub request_key: RequestKey,
    pub body: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachment_ids: Vec<AttachmentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageId>,
}

impl Post {
    pub fn new(
        body: String,
        attachment_ids: Vec<AttachmentId>,
        reply_to: Option<MessageId>,
    ) -> Self {
        Self {
            request_key: RequestKey::from(uuid::Uuid::new_v4().to_string()),
            body,
            attachment_ids,
            reply_to,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Change {
    Edit(String),
    Delete,
    Reaction(MessageReaction, bool),
}

#[derive(Clone, Debug)]
pub struct Page {
    pub messages: Vec<Message>,
    pub full: bool,
}

#[derive(Clone, Debug)]
pub struct RoomSync {
    pub existing: Vec<Message>,
    pub newer: Vec<Message>,
    pub initial: bool,
    pub has_older: bool,
}

impl ChatApi {
    pub async fn post(&self, room: &RoomId, payload: &Post) -> Result<Message, ApiError> {
        self.0
            .json(
                self.0
                    .request(Method::POST, &["api", "rooms", room.as_str(), "messages"])
                    .json(payload),
            )
            .await
    }

    pub async fn change(
        &self,
        room: &RoomId,
        id: &MessageId,
        change: &Change,
    ) -> Result<Message, ApiError> {
        let root = ["api", "rooms", room.as_str(), "messages", id.as_str()];
        let request = match change {
            Change::Edit(body) => self
                .0
                .request(Method::PATCH, &root)
                .json(&serde_json::json!({ "body": body })),
            Change::Delete => self.0.request(Method::DELETE, &root),
            Change::Reaction(reaction, add) => {
                let segments = [root.as_slice(), &["reactions", reaction.as_str()]].concat();
                let method = if *add { Method::PUT } else { Method::DELETE };
                self.0.request(method, &segments)
            }
        };
        self.0.json(request).await
    }

    pub async fn older(&self, room: &RoomId, before: &MessageId) -> Result<Page, ApiError> {
        self.page(room, Some(before.as_str()), None).await
    }

    pub async fn sync(&self, room: &RoomId, previous: PreviousSync) -> Result<RoomSync, ApiError> {
        if !previous.loaded {
            let page = self.page(room, None, None).await?;
            return Ok(RoomSync {
                existing: Vec::new(),
                newer: page.messages,
                initial: true,
                has_older: page.full,
            });
        }

        let watermark = previous.high_water.as_ref();
        let mut after = watermark.map_or(EMPTY_ROOM, MessageId::as_str).to_owned();
        let mut newer = Vec::new();
        loop {
            let page = self.page(room, None, Some(&after)).await?;
            let last = page.messages.last().map(|m| m.id.to_string());
            newer.extend(page.messages);
            if !page.full {
                break;
            }
            after = last
                .filter(|cursor| cursor > &after)
                .ok_or(ApiError::InvalidResponse)?;
        }

        // No change replay exists for held messages. Page back through the retained
        // range, including the captured high-water row, without inserting gaps.
        let mut existing = Vec::new();
        if let (Some(oldest), Some(watermark)) = (previous.oldest, watermark) {
            let mut before = successor(watermark.as_str());
            loop {
                let page = self.page(room, before.as_deref(), None).await?;
                let last = page.messages.last().map(|m| m.id.clone());
                existing.extend(
                    page.messages
                        .into_iter()
                        .filter(|m| m.id >= oldest && m.id <= *watermark),
                );
                if !page.full || last.as_ref().is_none_or(|id| id <= &oldest) {
                    break;
                }
                let last = last.unwrap().to_string();
                if before.as_ref().is_some_and(|before| before <= &last) {
                    return Err(ApiError::InvalidResponse);
                }
                before = Some(last);
            }
        }

        Ok(RoomSync {
            existing,
            newer,
            initial: false,
            has_older: false,
        })
    }

    async fn page(
        &self,
        room: &RoomId,
        before: Option<&str>,
        after: Option<&str>,
    ) -> Result<Page, ApiError> {
        #[derive(Serialize)]
        struct Query<'a> {
            limit: usize,
            before: Option<&'a str>,
            after: Option<&'a str>,
        }

        #[derive(Deserialize)]
        struct MessageList {
            messages: Vec<Message>,
        }

        let page: MessageList = self
            .0
            .json(
                self.0
                    .request(Method::GET, &["api", "rooms", room.as_str(), "messages"])
                    .query(&Query {
                        limit: PAGE_SIZE,
                        before,
                        after,
                    }),
            )
            .await?;

        let messages = page.messages;
        let ordered = messages.windows(2).all(|pair| {
            if after.is_some() {
                pair[0].id < pair[1].id
            } else {
                pair[0].id > pair[1].id
            }
        });
        if !ordered
            || messages.len() > PAGE_SIZE
            || messages.iter().any(|m| {
                &m.room_id != room
                    || before.is_some_and(|cursor| m.id.as_str() >= cursor)
                    || after.is_some_and(|cursor| m.id.as_str() <= cursor)
            })
        {
            return Err(ApiError::InvalidResponse);
        }
        Ok(Page {
            full: messages.len() == PAGE_SIZE,
            messages,
        })
    }
}

/// The listing boundary is exclusive; the next ULID includes the high-water row.
fn successor(id: &str) -> Option<String> {
    let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = id.as_bytes().to_vec();
    if bytes.len() != 26 {
        return None;
    }
    for index in (0..bytes.len()).rev() {
        let digit = alphabet.iter().position(|byte| byte == &bytes[index])?;
        let max = if index == 0 { 7 } else { 31 };
        if digit < max {
            bytes[index] = alphabet[digit + 1];
            return String::from_utf8(bytes).ok();
        }
        bytes[index] = b'0';
    }
    None
}
