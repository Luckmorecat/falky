use chrono::{TimeZone, Utc};

use crate::{
    ApiClient, Origin,
    attachments::{AttachmentsApi, Content, MAX_FILE_BYTES},
    model::{MessageReaction, ReactionGroup},
};

use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

fn message(id: &str) -> Message {
    Message {
        id: id.into(),
        room_id: "room".into(),
        author_id: "alice".into(),
        author_name: "Alice".into(),
        body: "hi".into(),
        created_at: Utc.with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap(),
        attachments: Vec::new(),
        reply_to: None,
        edited_at: None,
        deleted: false,
        reactions: Vec::new(),
    }
}

#[test]
fn linkifier_preserves_text_and_handles_unicode_and_sentence_punctuation() {
    for (body, links) in [
        ("see https://a.example/x, then", vec!["https://a.example/x"]),
        ("javascript:alert(1) ftp://example", vec![]),
        ("(https://a.example)", vec!["https://a.example"]),
        (
            "https://example.org/Falco_(genus)",
            vec!["https://example.org/Falco_(genus)"],
        ),
        (
            "«HTTP://a.example/птахи» і https://я.example.",
            vec!["HTTP://a.example/птахи", "https://я.example"],
        ),
        ("https:// a https://b.example.", vec!["https://b.example"]),
    ] {
        let parts = split_links(body);
        assert_eq!(parts.iter().map(|part| part.text).collect::<String>(), body);
        assert_eq!(
            parts
                .iter()
                .filter(|p| p.link)
                .map(|p| p.text)
                .collect::<Vec<_>>(),
            links
        );
    }
    assert!(!can_post(" \n\t ", 0));
    assert!(can_post("", 1));
    assert!(can_post(&"😀".repeat(4000), 0));
    assert!(!can_post(&"x".repeat(4001), 4));
}

#[test]
fn chronological_feed_groups_names_and_uses_a_single_new_boundary() {
    let mut other_day = message("01");
    other_day.created_at -= chrono::Duration::days(1);
    let renamed = Message {
        author_name: "Alisa".into(),
        ..message("03")
    };
    let third = message("04");
    let messages = [other_day, message("02"), renamed, third, message("05")];
    let boundary = Some("02".into());
    let items = feed(messages.iter(), Some(&boundary));
    assert!(matches!(
        items.as_slice(),
        [
            FeedItem::Day(_),
            FeedItem::Row {
                continued: false,
                ..
            },
            FeedItem::Day(_),
            FeedItem::Row {
                continued: false,
                ..
            },
            FeedItem::New,
            FeedItem::Row {
                continued: false,
                ..
            },
            FeedItem::Row {
                continued: false,
                ..
            },
            FeedItem::Row {
                continued: true,
                ..
            },
        ]
    ));
}

#[test]
fn reconnect_cursor_does_not_advance_across_a_live_jump_until_backfill_merges() {
    let mut timeline = Timeline::default();
    let room = RoomId::from("room");
    let stamp = timeline.request_stamp();
    timeline.merge_http(stamp, vec![message("01"), message("02")], true);
    let feed = timeline.room_mut(room.clone());
    feed.loaded = true;
    feed.finish_sync();
    assert_eq!(
        timeline.begin_reconnect()[&room].high_water,
        Some("02".into())
    );
    assert!(timeline.live("event1".into(), message("07"), true));
    assert_eq!(
        timeline.begin_reconnect()[&room].high_water,
        Some("02".into())
    );
    let stamp = timeline.request_stamp();
    timeline.merge_http(
        stamp,
        vec![message("07"), message("03"), message("06")],
        true,
    );
    timeline.room_mut(room.clone()).finish_sync();
    assert!(!timeline.live("event2".into(), message("03"), true));
    assert_eq!(
        timeline
            .room(&room)
            .unwrap()
            .messages()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["01", "02", "03", "06", "07"]
    );
    assert_eq!(timeline.room(&room).unwrap().high_water, Some("07".into()));
}

#[test]
fn late_http_and_duplicate_live_events_do_not_replace_a_newer_update() {
    let mut timeline = Timeline::default();
    let room = "room".into();
    let msg = "02".into();
    let initial = timeline.request_stamp();
    timeline.merge_http(initial, vec![message("02")], true);
    let request = timeline.request_stamp();
    let reacted = Message {
        reactions: vec![ReactionGroup {
            reaction: MessageReaction::Up,
            visitor_ids: vec!["bob".into()],
        }],
        ..message("02")
    };
    assert!(!timeline.live("0004".into(), reacted.clone(), false));
    assert!(!timeline.live("0003".into(), message("02"), false));
    timeline.merge_http(request, vec![message("02")], true);
    assert_eq!(timeline.room(&room).unwrap().get(&msg), Some(&reacted));

    let next = timeline.request_stamp();
    timeline.merge_http(next, vec![message("02")], false);
    assert_eq!(
        timeline.room(&room).unwrap().get(&msg),
        Some(&message("02"))
    );
}

#[test]
fn an_update_for_unpaged_history_stays_hidden_until_the_row_is_loaded() {
    let mut timeline = Timeline::default();
    let loading = timeline.request_stamp();
    let older = Message {
        body: "remotely edited".into(),
        edited_at: Some(Utc::now()),
        ..message("01")
    };
    assert!(!timeline.live("0001".into(), older.clone(), false));
    let room = "room".into();
    assert!(timeline.room(&room).unwrap().messages().next().is_none());
    timeline.merge_http(loading, vec![message("01")], true);
    assert_eq!(
        timeline.room(&room).unwrap().messages().next(),
        Some(&older)
    );
}

#[test]
fn attachment_expiry_dominates_stale_message_and_metadata_responses() {
    let mut timeline = Timeline::default();
    let attachment = Attachment {
        id: "private-id".into(),
        filename: "a.webp".into(),
        content_type: "image/webp".into(),
        size: 10,
        inline: true,
        width: 20,
        height: 10,
        availability: AttachmentAvailability::Posted,
        expires_at: None,
        content_url: "/ignored".into(),
    };
    let row = Message {
        attachments: vec![attachment.clone()],
        ..message("01")
    };
    let stamp = timeline.request_stamp();
    timeline.merge_http(stamp, vec![row.clone()], true);
    assert_eq!(timeline.available_attachments().count(), 1);
    timeline.expire([attachment.id.clone()]);
    timeline.attachment_metadata(attachment);
    let stamp = timeline.request_stamp();
    timeline.merge_http(stamp, vec![row], true);
    assert_eq!(timeline.available_attachments().count(), 0);
    assert_eq!(
        timeline
            .room(&"room".into())
            .unwrap()
            .get(&"01".into())
            .unwrap()
            .attachments[0]
            .availability,
        AttachmentAvailability::Expired
    );
}

#[test]
fn unread_counts_only_held_rows_after_the_cursor() {
    let mut timeline = Timeline::default();
    let id = RoomId::from("room");
    let own = VisitorId::from("me");
    let absent = MessageId::from("03");
    let exact = MessageId::from("04");
    let latest = MessageId::from("06");
    let future = MessageId::from("07");
    assert_eq!(timeline.room_mut(id.clone()).unread(None, &own), 0);

    let initial = timeline.request_stamp();
    timeline.merge_http(
        initial,
        [
            message("04"),
            Message {
                author_id: own.clone(),
                ..message("05")
            },
            Message {
                deleted: true,
                ..message("06")
            },
        ],
        true,
    );
    let older_page = timeline.request_stamp();
    assert!(!timeline.live("event1".into(), message("02"), false));
    let room = timeline.room(&id).unwrap();
    assert_eq!(room.unread(None, &own), 2);
    assert_eq!(room.unread(Some(&absent), &own), 2);
    assert_eq!(room.unread(Some(&exact), &own), 1);
    assert_eq!(room.unread(Some(&latest), &own), 0);
    assert_eq!(room.unread(Some(&future), &own), 0);

    timeline.merge_http(older_page, [message("01"), message("02")], true);
    let room = timeline.room(&id).unwrap();
    assert_eq!(room.unread(None, &own), 4);
    assert_eq!(room.unread(Some(&"01".into()), &own), 3);
    assert_eq!(room.unread(Some(&exact), &own), 1);
}

#[test]
fn unread_excludes_own_messages_and_disk_record_checks_both_scope_parts() {
    let mut timeline = Timeline::default();
    let stamp = timeline.request_stamp();
    timeline.merge_http(
        stamp,
        vec![
            message("01"),
            Message {
                author_id: "me".into(),
                ..message("02")
            },
            message("03"),
        ],
        true,
    );
    let id = "room".into();
    let identity = "me".into();
    let mut read = ReadState {
        viewed_room: Some(id),
        ..ReadState::default()
    };
    let id = read.viewed_room.clone().unwrap();
    read.mark(id.clone(), Some("01".into()));
    read.mark(id.clone(), None);
    let cursor = read.last_read[&id].as_ref();
    assert_eq!(timeline.room(&id).unwrap().unread(cursor, &identity), 1);

    let disk = tempfile::tempdir().unwrap();
    let path = disk.path().join("chat-state.json");
    let server = Origin::parse("https://example.org").unwrap();
    let other = Origin::parse("https://not.example.org").unwrap();
    read.save(&path, &server, &identity).unwrap();
    let restored = ReadState::load(&path, &server, &identity).unwrap();
    assert_eq!(restored, read);
    assert_eq!(
        timeline
            .room(&id)
            .unwrap()
            .unread(restored.last_read[&id].as_ref(), &identity),
        1
    );
    assert_eq!(
        ReadState::load(&path, &server, &"someone-else".into()).unwrap(),
        ReadState::default()
    );
    assert_eq!(
        ReadState::load(&path, &other, &identity).unwrap(),
        ReadState::default()
    );
    ReadState::clear(&path).unwrap();
    assert_eq!(
        ReadState::load(&path, &server, &identity).unwrap(),
        ReadState::default()
    );
}

#[tokio::test]
async fn reconnect_pages_after_watermark_and_refreshes_the_held_message() {
    let (server, client) = connect_fixture().await;
    let first = "00000000000000000000000001";
    let upper = "00000000000000000000000002";
    let held = message(first);
    let fixture = tokio::spawn(async move {
        let mut a = server.accept().await.unwrap().0;
        let request = request(&mut a).await;
        assert!(request.starts_with(&format!(
            "GET /api/rooms/room/messages?limit=100&after={first} "
        )));
        let ids = (2..=101).map(id).collect::<Vec<_>>();
        let page: Vec<_> = ids.iter().map(|id| message(id)).collect();
        reply(
            &mut a,
            "200 OK",
            &[],
            &serde_json::json!({ "messages": page }).to_string(),
        )
        .await;

        let mut b = server.accept().await.unwrap().0;
        let request2 = self::request(&mut b).await;
        assert!(request2.starts_with(&format!(
            "GET /api/rooms/room/messages?limit=100&after={} ",
            ids.last().unwrap()
        )));
        reply(
            &mut b,
            "200 OK",
            &[],
            &serde_json::json!({ "messages": [message(&id(102))] }).to_string(),
        )
        .await;

        let mut c = server.accept().await.unwrap().0;
        let request3 = self::request(&mut c).await;
        assert!(request3.starts_with(&format!(
            "GET /api/rooms/room/messages?limit=100&before={upper} "
        )));
        let changed = Message {
            body: "Offline edit".into(),
            ..held
        };
        reply(
            &mut c,
            "200 OK",
            &[],
            &serde_json::json!({ "messages": [changed] }).to_string(),
        )
        .await;
    });
    let sync = ChatApi(client)
        .sync(
            &"room".into(),
            PreviousSync {
                loaded: true,
                high_water: Some(first.into()),
                oldest: Some(first.into()),
            },
        )
        .await
        .unwrap();
    fixture.await.unwrap();
    assert_eq!(sync.newer.len(), 101);
    assert_eq!(sync.newer.last().unwrap().id.as_str(), id(102));
    assert_eq!(sync.existing[0].body, "Offline edit");
}

#[tokio::test]
async fn exact_post_payload_replays_and_authenticated_content_revalidates() {
    let (server, client) = connect_fixture().await;
    let expected = Post::new(
        "  keep spaces  ".into(),
        vec!["image2".into(), "image1".into()],
        Some("reply".into()),
    );
    let wire = serde_json::to_value(&expected).unwrap();
    let fixture = tokio::spawn(async move {
        for status in ["201 Created", "200 OK"] {
            let mut post = server.accept().await.unwrap().0;
            let request = request(&mut post).await;
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(
                    request.split_once("\r\n\r\n").unwrap().1
                )
                .unwrap(),
                wire
            );
            let response = serde_json::to_string(&message("01")).unwrap();
            assert!(!response.contains("requestKey"));
            reply(
                &mut post,
                status,
                &[(
                    "Set-Cookie",
                    "falky_visitor=fixture; Path=/api; Max-Age=3600; Secure; HttpOnly",
                )],
                &response,
            )
            .await;
        }
        let mut image = server.accept().await.unwrap().0;
        let r = request(&mut image).await;
        assert!(r.starts_with("GET /api/attachments/image1/content "));
        assert!(r.contains("cookie: falky_visitor=fixture"));
        reply(
            &mut image,
            "200 OK",
            &[("Content-Type", "image/webp"), ("ETag", "\"immutable\"")],
            "data",
        )
        .await;
        for status in ["304 Not Modified", "410 Gone"] {
            let mut image = server.accept().await.unwrap().0;
            let r = request(&mut image).await;
            assert!(r.contains("cookie: falky_visitor=fixture"));
            assert!(r.contains("if-none-match: \"immutable\""));
            reply(&mut image, status, &[("ETag", "\"immutable\"")], "").await;
        }
    });
    let api = ChatApi(client.clone());
    let room = "room".into();
    assert_eq!(
        api.post(&room, &expected).await.unwrap(),
        api.post(&room, &expected).await.unwrap()
    );
    let files = AttachmentsApi(client);
    let image = "image1".into();
    let downloaded = files.image(&image, None, MAX_FILE_BYTES).await.unwrap();
    let Content::Image { etag, bytes } = downloaded else {
        panic!("missing content");
    };
    assert_eq!(bytes, "data");
    assert!(matches!(
        files
            .image(&image, etag.clone(), MAX_FILE_BYTES)
            .await
            .unwrap(),
        Content::Unchanged
    ));
    assert_eq!(
        files
            .image(&image, etag, MAX_FILE_BYTES)
            .await
            .unwrap_err()
            .status(),
        Some(reqwest::StatusCode::GONE)
    );
    fixture.await.unwrap();
}

async fn connect_fixture() -> (TcpListener, ApiClient) {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = Origin::parse(&format!("http://{}", server.local_addr().unwrap())).unwrap();
    (server, ApiClient::new(origin).unwrap())
}

async fn request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&bytes);
        if let Some((head, body)) = text.split_once("\r\n\r\n") {
            let content_len = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .and_then(|len| len.parse().ok())
                .unwrap_or(0);
            if body.len() >= content_len {
                return text.into_owned();
            }
        }
    }
}

async fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &str) {
    let headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let response = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await.unwrap();
    stream.shutdown().await.unwrap();
}

fn id(mut n: usize) -> String {
    let mut chars = [b'0'; 26];
    for digit in chars.iter_mut().rev() {
        *digit = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[n % 32];
        n /= 32;
    }
    String::from_utf8(chars.into()).unwrap()
}
