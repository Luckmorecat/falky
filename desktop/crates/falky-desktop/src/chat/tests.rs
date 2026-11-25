use chrono::Utc;
use falky_core::{
    Origin,
    model::{
        AttachmentAvailability, LiveEvent, PaletteName, ReconnectGeneration, SessionGeneration,
        VisitorColour,
    },
};

use super::*;

fn setup() -> (Chat, SessionScope, LiveScope) {
    let origin = Origin::parse("http://127.0.0.1:8000").unwrap();
    let scope = SessionScope {
        origin: origin.clone(),
        generation: SessionGeneration(3),
    };
    let live = LiveScope {
        session: scope.clone(),
        generation: ReconnectGeneration(1),
    };
    let visitor = Visitor {
        id: "me".into(),
        name: "Me".into(),
        name_taken: false,
        colour: VisitorColour {
            visitor_id: "me".into(),
            palette: PaletteName::Sky,
            revision: 1,
        },
    };
    let chat = Chat::new(
        scope.clone(),
        ApiClient::new(origin).unwrap(),
        visitor,
        ReadState::default(),
    );
    (chat, scope, live)
}

fn incoming(live: &LiveScope, id: &str, author: &str) -> LiveUpdate {
    LiveUpdate {
        scope: live.clone(),
        event: LiveEvent {
            v: 1,
            event_id: format!("event-{id}").into(),
            room_id: Some("room".into()),
            timestamp: Utc::now(),
            payload: LivePayload::MessageCreated(ChatMessage {
                id: id.into(),
                room_id: "room".into(),
                author_id: author.into(),
                author_name: author.into(),
                body: format!("Body {id}"),
                created_at: Utc::now(),
                attachments: Vec::new(),
                reply_to: None,
                edited_at: None,
                deleted: false,
                reactions: Vec::new(),
            }),
        },
    }
}

#[test]
fn live_ticker_shows_three_fresh_other_rows_and_expires() {
    let (mut chat, _, live) = setup();
    chat.begin_reconnect(&live);
    let room = "room".into();
    let _ = chat.select_room(Some(room));
    assert!(chat.on_live(&incoming(&live, "00", "me")).fresh.is_none());
    for id in ["01", "02", "03", "04"] {
        let event = incoming(&live, id, &format!("other-{id}"));
        assert!(chat.on_live(&event).fresh.is_some());
        assert!(chat.on_live(&event).fresh.is_none());
    }
    let ticker = chat
        .ticker(Language::En)
        .into_iter()
        .map(|line| line.summary)
        .collect::<Vec<_>>();
    assert_eq!(ticker, ["Body 02", "Body 03", "Body 04"]);
    assert_eq!(
        chat.ticker_visitors(),
        ["other-02", "other-03", "other-04"].map(VisitorId::from)
    );
    chat.ticker[0].1 -= TICKER_DURATION + Duration::from_millis(2);
    let _ = chat.update(Message::Tick);
    assert_eq!(chat.ticker(Language::En).len(), 2);
    assert_eq!(
        chat.ticker_visitors(),
        ["other-03", "other-04"].map(VisitorId::from)
    );
    let _ = chat.set_open(true);
    assert!(chat.ticker(Language::En).is_empty());
}

#[test]
fn early_event_does_not_become_read_history_or_move_retry_cursor() {
    let (mut chat, _, live) = setup();
    chat.begin_reconnect(&live);
    let room = "room".into();
    let _ = chat.select_room(Some(room));
    chat.on_live(&incoming(&live, "02", "other"));
    let LivePayload::MessageCreated(historical) = incoming(&live, "01", "history").event.payload
    else {
        unreachable!()
    };
    let LivePayload::MessageCreated(interleaved) = incoming(&live, "02", "other").event.payload
    else {
        unreachable!()
    };
    let stamp = chat.timeline.request_stamp();
    let _ = chat.merge_sync(
        "room".into(),
        stamp,
        RoomSync {
            existing: Vec::new(),
            newer: vec![interleaved, historical],
            initial: true,
            has_older: false,
        },
    );
    assert_eq!(chat.unread(&"room".into()), 1);
    let next = LiveScope {
        generation: ReconnectGeneration(2),
        ..live.clone()
    };
    chat.begin_reconnect(&next);
    assert!(
        chat.on_live(&incoming(&live, "03", "old-socket"))
            .fresh
            .is_none()
    );
    chat.on_live(&incoming(&next, "04", "other"));
    assert_eq!(chat.before_connect["room"].high_water, Some("02".into()));
}

#[test]
fn invalidation_keeps_session_unauthorized_authoritative_across_live_scopes() {
    let (mut chat, session, live) = setup();
    chat.begin_reconnect(&live);
    chat.invalidate_live();
    chat.begin_reconnect(&live);
    assert!(
        chat.on_live(&incoming(&live, "01", "other"))
            .fresh
            .is_none()
    );
    let unauthorized = ApiError::Http {
        status: reqwest::StatusCode::UNAUTHORIZED,
        code: None,
        retry_after: None,
    };
    let old_work = Work::Metadata(live.clone(), Err(unauthorized.clone()));
    let update = chat.update(Message::Finished(1, session.clone(), Box::new(old_work)));
    assert_eq!(update.unauthorized.as_ref(), Some(&session));

    let next = LiveScope {
        generation: ReconnectGeneration(2),
        ..live
    };
    chat.begin_reconnect(&next);
    assert!(
        chat.on_live(&incoming(&next, "01", "other"))
            .fresh
            .is_some()
    );
    let new_work = Work::Metadata(next, Err(unauthorized));
    let update = chat.update(Message::Finished(2, session.clone(), Box::new(new_work)));
    assert_eq!(update.unauthorized, Some(session));
}

fn with_posted_image() -> (Chat, LiveScope, ChatMessage, Attachment) {
    let (mut chat, _, live) = setup();
    chat.begin_reconnect(&live);
    let _ = chat.select_room(Some("room".into()));
    let attachment = Attachment {
        id: "image".into(),
        filename: "picture.webp".into(),
        content_type: "image/webp".into(),
        content_url: "/api/attachments/image/content".into(),
        availability: AttachmentAvailability::Posted,
        width: 1,
        height: 1,
        size: 4,
        inline: true,
        expires_at: None,
    };
    let mut update = incoming(&live, "01", "me");
    let LivePayload::MessageCreated(message) = &mut update.event.payload else {
        unreachable!()
    };
    message.attachments.push(attachment.clone());
    let message = message.clone();
    let _ = chat.on_live(&update);
    (chat, live, message, attachment)
}

#[test]
fn reconnect_denial_evicts_and_tombstones_images_across_stale_work() {
    let (mut chat, live, _, attachment) = with_posted_image();
    let id = attachment.id.clone();
    let thumbnail = Key(id.clone(), Size::Thumbnail);
    let viewer = Key(id.clone(), Size::Viewer);
    chat.cache.insert(thumbnail.clone(), images::test_image());
    chat.validated.insert(thumbnail.clone());
    chat.fetching.insert(thumbnail.clone(), Some(101));
    let next = LiveScope {
        generation: ReconnectGeneration(2),
        ..live.clone()
    };
    chat.begin_reconnect(&next);
    assert!(!chat.validated.contains(&thumbnail));

    let scope = chat.scope.clone();
    let mut stale_attachment = attachment.clone();
    stale_attachment.availability = AttachmentAvailability::Expired;
    let stale = Work::Metadata(live, Ok(vec![(id.clone(), Ok(stale_attachment))]));
    let _ = chat.update(Message::Finished(0, scope.clone(), Box::new(stale)));
    assert!(!chat.timeline.is_expired(&id));

    chat.fetching.insert(viewer.clone(), Some(102));
    let not_found = ApiError::Http {
        status: reqwest::StatusCode::NOT_FOUND,
        code: None,
        retry_after: None,
    };
    let _ = chat.finish(Work::Metadata(
        next.clone(),
        Ok(vec![(id.clone(), Err(not_found))]),
    ));
    let _ = chat.finish(Work::Image(
        101,
        thumbnail.clone(),
        Ok(Fetched::Image(images::test_image())),
    ));
    let _ = chat.finish(Work::Image(
        102,
        viewer.clone(),
        Ok(Fetched::Image(images::test_image())),
    ));
    let _ = chat.finish(Work::Metadata(next, Ok(vec![(id.clone(), Ok(attachment))])));
    assert!(chat.timeline.is_expired(&id));
    assert!(chat.cache.peek(&thumbnail).is_none());
    assert!(chat.cache.peek(&viewer).is_none());
}

#[test]
fn message_tombstones_evict_prior_images_from_live_mutation_and_sync() {
    for source in ["live", "mutation", "sync"] {
        let (mut chat, live, original, attachment) = with_posted_image();
        let key = Key(attachment.id.clone(), Size::Viewer);
        chat.cache.insert(key.clone(), images::test_image());
        chat.fetching.insert(key.clone(), Some(101));
        let mut deleted = original.clone();
        deleted.deleted = true;
        deleted.attachments.clear();
        let stamp = chat.timeline.request_stamp();
        match source {
            "live" => {
                let mut update = incoming(&live, "02", "me");
                update.event.payload = LivePayload::MessageUpdated(deleted);
                let _ = chat.on_live(&update);
            }
            "mutation" => {
                let _ = chat.finish(Work::Change(
                    original.room_id,
                    stamp,
                    original.id,
                    Change::Delete,
                    Ok(deleted),
                ));
            }
            "sync" => {
                let _ = chat.merge_sync(
                    original.room_id,
                    stamp,
                    RoomSync {
                        existing: vec![deleted],
                        newer: Vec::new(),
                        initial: false,
                        has_older: false,
                    },
                );
            }
            _ => unreachable!(),
        }
        let _ = chat.finish(Work::Image(
            101,
            key.clone(),
            Ok(Fetched::Image(images::test_image())),
        ));
        assert!(chat.timeline.is_expired(&attachment.id), "{source}");
        assert!(chat.cache.peek(&key).is_none(), "{source}");
    }
}

#[test]
fn reopening_image_requires_a_new_viewer_fetch() {
    let (mut chat, _, _, attachment) = with_posted_image();
    let room = RoomId::from("room");
    let id = attachment.id;
    let key = Key(id.clone(), Size::Viewer);
    let _ = chat.open_image(&room, id.clone());
    let old = chat.fetching[&key].unwrap();
    let _ = chat.close_modal();
    let _ = chat.open_image(&room, id);
    assert_eq!(chat.fetching[&key], None);
    let _ = chat.finish(Work::Image(
        old,
        key.clone(),
        Ok(Fetched::Image(images::test_image())),
    ));
    assert!(chat.cache.peek(&key).is_none());
    let next = chat.fetching[&key].unwrap();
    assert_ne!(old, next);
    let _ = chat.finish(Work::Image(
        next,
        key.clone(),
        Ok(Fetched::Image(images::test_image())),
    ));
    assert!(chat.validated.contains(&key));
}

#[test]
fn pending_edit_preserves_newer_composition_on_submit_and_completion() {
    let (mut chat, _, mut message, _) = with_posted_image();
    let room = message.room_id.clone();
    let id = message.id.clone();
    let _ = chat.compose_edit(room.clone(), id.clone());
    chat.composers.get_mut(&room).unwrap().content = text_editor::Content::with_text("first edit");
    let _ = chat.post_current(room.clone());
    let _ = chat.compose_edit(room.clone(), id.clone());
    chat.composers.get_mut(&room).unwrap().content = text_editor::Content::with_text("newer draft");
    let _ = chat.post_current(room.clone());
    assert!(
        chat.composers[&room]
            .content
            .text()
            .starts_with("newer draft")
    );
    assert!(matches!(
        chat.composers[&room].mode,
        Some(Compose::Edit { .. })
    ));

    let _ = chat.update(Message::Reply(id.clone()));
    chat.composers.get_mut(&room).unwrap().content = text_editor::Content::with_text("new reply");
    let stamp = chat.timeline.request_stamp();
    message.body = "first edit".into();
    message.edited_at = Some(Utc::now());
    let _ = chat.finish(Work::Change(
        room.clone(),
        stamp,
        id,
        Change::Edit("first edit".into()),
        Ok(message),
    ));
    assert!(
        chat.composers[&room]
            .content
            .text()
            .starts_with("new reply")
    );
    assert!(matches!(
        chat.composers[&room].mode,
        Some(Compose::Reply(_))
    ));
}

#[test]
fn current_session_receives_unauthorized_and_retired_completion_is_ignored() {
    let (mut chat, scope, _) = setup();
    let error = ApiError::Http {
        status: reqwest::StatusCode::UNAUTHORIZED,
        code: None,
        retry_after: None,
    };
    let gone = SessionScope {
        generation: SessionGeneration(2),
        ..scope.clone()
    };
    let task = Message::Finished(1, gone, Box::new(Work::Limits(Err(error.clone()))));
    assert!(chat.update(task).unauthorized.is_none());
    let task = Message::Finished(1, scope.clone(), Box::new(Work::Limits(Err(error))));
    assert_eq!(chat.update(task).unauthorized, Some(scope));
}

#[test]
fn live_before_http_ack_keeps_pending_by_request_key_and_one_confirmed_row() {
    let (mut chat, _, live) = setup();
    chat.begin_reconnect(&live);
    let room = RoomId::from("room");
    let first = Post::new("same body".into(), Vec::new(), None);
    let second = Post::new("same body".into(), Vec::new(), None);
    chat.pending.insert(
        room.clone(),
        [first.clone(), second.clone()]
            .into_iter()
            .map(|payload| Pending {
                payload,
                reply: None,
                images: Vec::new(),
                error: None,
            })
            .collect(),
    );
    let stamp = chat.timeline.request_stamp();
    let mut event = incoming(&live, "01", "me");
    let LivePayload::MessageCreated(ref mut message) = event.event.payload else {
        unreachable!()
    };
    message.body = "same body".into();
    let message = message.clone();
    chat.on_live(&event);
    assert_eq!(chat.pending[&room].len(), 2);
    let _ = chat.finish(Work::Post(
        room.clone(),
        stamp,
        first.request_key,
        Ok(message),
    ));
    assert_eq!(chat.pending[&room].len(), 1);
    assert_eq!(chat.pending[&room][0].payload, second);
    assert_eq!(chat.timeline.room(&room).unwrap().messages().count(), 1);
}
