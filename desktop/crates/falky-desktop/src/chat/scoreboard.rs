use chrono::{TimeZone, Utc};
use falky_core::model::AttachmentAvailability;

use super::*;

pub(crate) fn load_timeline(chat: &mut Chat, room: &RoomId) {
    const ROWS: usize = 2_000;
    let stamp = chat.timeline.request_stamp();
    let timestamp = Utc.with_ymd_and_hms(2024, 1, 15, 12, 0, 0).unwrap();
    let messages = (0..ROWS)
        .map(|index| {
            let author = index / 4 % 6;
            let attachments = if index % 40 == 39 {
                vec![Attachment {
                    id: format!("attachment-{index}").into(),
                    filename: "desk.webp".into(),
                    content_type: "image/webp".into(),
                    content_url: format!("/api/attachments/{index}/content"),
                    availability: AttachmentAvailability::Posted,
                    width: 320,
                    height: 180,
                    size: 1_300,
                    inline: true,
                    expires_at: None,
                }]
            } else {
                Vec::new()
            };
            let body = if index % 13 == 0 {
                format!("Message {index} references https://example.invalid/room/{index}.")
            } else {
                format!("Message {index} in the studio chat")
            };
            ChatMessage {
                id: format!("{index:04}").into(),
                room_id: room.clone(),
                author_id: format!("visitor-{author}").into(),
                author_name: format!("Member {}", author + 1),
                body,
                created_at: timestamp + chrono::TimeDelta::seconds(index as i64 * 3),
                attachments,
                reply_to: None,
                edited_at: None,
                deleted: false,
                reactions: Vec::new(),
            }
        })
        .collect::<Vec<_>>();
    let thumbnails = messages
        .iter()
        .flat_map(|message| {
            message
                .attachments
                .iter()
                .map(|attachment| Key(attachment.id.clone(), Size::Thumbnail))
        })
        .collect::<Vec<_>>();
    drop(chat.merge_sync(
        room.clone(),
        stamp,
        RoomSync {
            existing: Vec::new(),
            newer: messages,
            initial: true,
            has_older: false,
        },
    ));
    for key in thumbnails {
        chat.cache.insert(key.clone(), images::test_image());
        chat.visible.insert(key.clone());
        chat.validated.insert(key);
    }
    assert_eq!(chat.timeline.room(room).unwrap().messages().count(), ROWS);
}

pub(crate) fn image_reply(chat: &Chat, id: AttachmentId) -> Message {
    let key = Key(id, Size::Viewer);
    let generation = chat.fetching[&key].expect("open viewer requested an image");
    let image = if chat.cache.peek(&key).is_some() {
        Fetched::Unchanged
    } else {
        Fetched::Image(images::scoreboard::viewer_image())
    };
    completion(chat, Work::Image(generation, key, Ok(image)))
}

pub(crate) fn paste_reply(chat: &Chat, room: RoomId, pixels: Vec<u8>) -> Message {
    let input = images::scoreboard::pixels_to_clipboard(pixels, chat.limits.input_bytes);
    assert!(input.is_ok(), "valid scoreboard clipboard input");
    completion(chat, Work::Paste(room, ClipboardContents::Image(input)))
}

pub(crate) fn only_draft(chat: &Chat, room: &RoomId) -> u64 {
    let drafts = &chat.composers[room].drafts;
    assert_eq!(drafts.len(), 1);
    drafts[0].id
}

pub(crate) fn completion(chat: &Chat, work: Work) -> Message {
    assert_eq!(chat.jobs.len(), 1, "one in-flight fixture request");
    let &job = chat.jobs.keys().next().unwrap();
    Message::Finished(job, chat.scope.clone(), Box::new(work))
}
