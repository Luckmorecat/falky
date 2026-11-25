mod api;
mod feed;
mod storage;
#[cfg(test)]
mod tests;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::Bound::{Excluded, Unbounded},
};

use serde::{Deserialize, Serialize};

use crate::model::{
    Attachment, AttachmentAvailability, AttachmentId, EventId, Message, MessageId, MessageReply,
    RoomId, VisitorId,
};

pub use api::{Change, ChatApi, Page, Post, RoomSync};
pub use feed::{FeedItem, MESSAGE_MAX, TextPart, can_post, feed, split_links};

/// Persisted separately by origin and identity. An initialized empty room has no read ID.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ReadState {
    pub viewed_room: Option<RoomId>,
    #[serde(default)]
    pub last_read: BTreeMap<RoomId, Option<MessageId>>,
}

impl ReadState {
    pub fn mark(&mut self, room: RoomId, cursor: Option<MessageId>) {
        let previous = self.last_read.entry(room).or_default();
        if cursor > *previous {
            *previous = cursor;
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct Stamp(u64);

#[derive(Debug, Default)]
pub struct Timeline {
    rooms: HashMap<RoomId, RoomTimeline>,
    expired: HashSet<AttachmentId>,
    clock: Stamp,
}

#[derive(Debug, Default)]
pub struct RoomTimeline {
    // Live updates to unpaged rows are held privately until that ID actually enters the feed.
    entries: BTreeMap<MessageId, Entry>,
    pub loaded: bool,
    pub has_older: bool,
    pub high_water: Option<MessageId>,
    pub synced: bool,
    pub first_live: Option<MessageId>,
}

#[derive(Debug)]
struct Entry {
    message: Message,
    stamp: Stamp,
    event: Option<EventId>,
    held: bool,
}

impl RoomTimeline {
    pub fn messages(&self) -> impl DoubleEndedIterator<Item = &Message> {
        self.entries
            .values()
            .filter(|entry| entry.held)
            .map(|entry| &entry.message)
    }

    pub fn get(&self, id: &MessageId) -> Option<&Message> {
        self.entries
            .get(id)
            .filter(|entry| entry.held)
            .map(|entry| &entry.message)
    }

    pub fn unread(&self, after: Option<&MessageId>, own: &VisitorId) -> usize {
        self.entries
            .range::<MessageId, _>((after.map_or(Unbounded, Excluded), Unbounded))
            .filter(|(_, entry)| entry.held && entry.message.author_id != *own)
            .count()
    }

    pub fn reply(&self, fallback: &MessageReply) -> MessageReply {
        self.get(&fallback.id)
            .map(reply_of)
            .unwrap_or_else(|| fallback.clone())
    }

    pub fn previous_sync(&self) -> PreviousSync {
        PreviousSync {
            loaded: self.loaded,
            high_water: self.high_water.clone(),
            oldest: self.messages().next().map(|message| message.id.clone()),
        }
    }

    pub fn finish_sync(&mut self) {
        let high_water = self
            .messages()
            .next_back()
            .map(|message| message.id.clone());
        self.high_water = high_water;
        self.synced = true;
    }
}

#[derive(Clone, Debug, Default)]
pub struct PreviousSync {
    pub loaded: bool,
    pub high_water: Option<MessageId>,
    pub oldest: Option<MessageId>,
}

impl Timeline {
    pub fn room(&self, id: &RoomId) -> Option<&RoomTimeline> {
        self.rooms.get(id)
    }

    pub fn room_mut(&mut self, id: RoomId) -> &mut RoomTimeline {
        self.rooms.entry(id).or_default()
    }

    pub fn messages(&self) -> impl Iterator<Item = &Message> {
        self.rooms.values().flat_map(RoomTimeline::messages)
    }

    /// Record what was known before the newly connected socket can deliver frames.
    pub fn begin_reconnect(&mut self) -> HashMap<RoomId, PreviousSync> {
        self.rooms
            .iter_mut()
            .map(|(id, room)| {
                room.synced = false;
                (id.clone(), room.previous_sync())
            })
            .collect()
    }

    /// A response cannot displace rows changed by a later request or live frame.
    pub fn request_stamp(&mut self) -> Stamp {
        self.clock.0 += 1;
        self.clock
    }

    pub fn live(&mut self, event: EventId, message: Message, created: bool) -> bool {
        let stamp = self.request_stamp();
        let id = message.id.clone();
        let room = message.room_id.clone();
        let fresh = self.merge(message, stamp, Some(event), created) && created;
        if fresh {
            let room = self.room_mut(room);
            if room.first_live.as_ref().is_none_or(|first| id < *first) {
                room.first_live = Some(id.clone());
            }
            if room.synced && room.high_water.as_ref().is_none_or(|high| id > *high) {
                room.high_water = Some(id);
            }
        }
        fresh
    }

    pub fn merge_http(
        &mut self,
        stamp: Stamp,
        messages: impl IntoIterator<Item = Message>,
        insert: bool,
    ) {
        for message in messages {
            self.merge(message, stamp, None, insert);
        }
    }

    fn merge(
        &mut self,
        mut message: Message,
        stamp: Stamp,
        event: Option<EventId>,
        insert: bool,
    ) -> bool {
        self.expire(
            message
                .attachments
                .iter()
                .filter(|attachment| {
                    matches!(
                        attachment.availability,
                        AttachmentAvailability::Expired | AttachmentAvailability::Cancelled
                    )
                })
                .map(|attachment| attachment.id.clone()),
        );
        for attachment in &mut message.attachments {
            if self.expired.contains(&attachment.id) {
                attachment.availability = AttachmentAvailability::Expired;
            }
        }
        let room = self.rooms.entry(message.room_id.clone()).or_default();
        let id = message.id.clone();
        let Some(prior) = room.entries.get_mut(&id) else {
            room.entries.insert(
                id,
                Entry {
                    message,
                    stamp,
                    event,
                    held: insert,
                },
            );
            return insert;
        };
        let newly_held = insert && !prior.held;
        prior.held |= insert;
        let old_event = event
            .as_ref()
            .zip(prior.event.as_ref())
            .is_some_and(|(incoming, previous)| incoming <= previous);
        if old_event || stamp < prior.stamp {
            return newly_held;
        }
        // An edit timestamp and deletion are monotonic, even across request channels.
        if prior.message.deleted && !message.deleted || prior.message.edited_at > message.edited_at
        {
            return newly_held;
        }
        prior.message = message;
        prior.stamp = stamp;
        if event.is_some() {
            prior.event = event;
        }
        newly_held
    }

    pub fn available_attachments(&self) -> impl Iterator<Item = &Attachment> {
        self.messages()
            .flat_map(|message| &message.attachments)
            .filter(|a| a.availability == AttachmentAvailability::Posted)
    }

    pub fn is_expired(&self, id: &AttachmentId) -> bool {
        self.expired.contains(id)
    }

    pub fn expire(&mut self, ids: impl IntoIterator<Item = AttachmentId>) {
        for id in ids {
            if self.expired.insert(id.clone()) {
                self.visit_attachments(&id, |a| a.availability = AttachmentAvailability::Expired);
            }
        }
    }

    pub fn attachment_metadata(&mut self, fresh: Attachment) {
        if matches!(
            fresh.availability,
            AttachmentAvailability::Expired | AttachmentAvailability::Cancelled
        ) {
            self.expire([fresh.id]);
        } else if !self.expired.contains(&fresh.id) {
            self.visit_attachments(&fresh.id, |a| *a = fresh.clone());
        }
    }

    fn visit_attachments(&mut self, id: &AttachmentId, mut update: impl FnMut(&mut Attachment)) {
        for room in self.rooms.values_mut() {
            for entry in room.entries.values_mut() {
                for attachment in &mut entry.message.attachments {
                    if &attachment.id == id {
                        update(attachment);
                    }
                }
            }
        }
    }
}

pub fn reply_of(message: &Message) -> MessageReply {
    let mut excerpt = message
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if let Some((index, _)) = excerpt.char_indices().nth(120) {
        let previous = excerpt[..index].char_indices().next_back().unwrap().0;
        excerpt.truncate(previous);
        excerpt.push('…');
    }
    MessageReply {
        id: message.id.clone(),
        author_name: message.author_name.clone(),
        excerpt,
        deleted: message.deleted,
    }
}
