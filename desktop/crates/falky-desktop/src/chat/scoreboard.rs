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
