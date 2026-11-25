use falky_core::{Origin, model::SessionGeneration};
use futures_util::StreamExt;

use super::*;

#[test]
fn colour_requests_retry_failed_ids_with_capped_backoff() {
    let mut requests = ColourRequests::default();
    let id = VisitorId::from("participant");
    let mut now = Instant::now();

    for expected in [1, 2, 4, 8, 8] {
        let sent = requests.start([id.clone()].into_iter(), now);
        assert_eq!(sent, std::slice::from_ref(&id));
        assert!(requests.start([id.clone()].into_iter(), now).is_empty());
        let delay = requests.failed(sent, now);
        assert_eq!(delay, Duration::from_secs(expected));
        assert!(requests.start([id.clone()].into_iter(), now).is_empty());
        now += delay;
    }

    assert_eq!(
        requests.start([id.clone()].into_iter(), now),
        std::slice::from_ref(&id)
    );
    requests.succeeded();
    assert!(requests.start([id].into_iter(), now).is_empty());

    let new_id = VisitorId::from("new-participant");
    let sent = requests.start([new_id].into_iter(), now);
    assert_eq!(requests.failed(sent, now), Duration::from_secs(1));
}

#[test]
fn quit_retries_a_failed_read_state_write() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked");
    std::fs::write(&blocked, b"file in place of the directory").unwrap();
    let path = blocked.join("chat-read.json");
    let origin = Origin::parse("https://example.com").unwrap();
    let identity = VisitorId::from("account");
    let read = ReadState {
        viewed_room: Some("lobby".into()),
        ..ReadState::default()
    };
    let mut checkpoint = ReadCheckpoint {
        saved: ReadState::default(),
        retry_at: None,
    };

    checkpoint.save(&read, &path, &origin, &identity, false);
    assert_ne!(checkpoint.saved, read);
    std::fs::remove_file(blocked).unwrap();
    checkpoint.save(&read, &path, &origin, &identity, false);
    assert!(!path.exists());

    checkpoint.save(&read, &path, &origin, &identity, true);
    assert_eq!(ReadState::load(&path, &origin, &identity).unwrap(), read);
    assert_eq!(checkpoint.saved, read);
}

#[tokio::test]
async fn voice_watcher_delivers_terminal_unauthorized_after_snapshot_close() {
    let scope = SessionScope {
        origin: Origin::parse("https://example.com").unwrap(),
        generation: SessionGeneration(8),
    };
    let snapshot = VoiceSnapshot {
        scope: scope.clone(),
        room: None,
        joining: None,
        connection: None,
        reconnecting: false,
        muted: true,
        deafened: false,
        listen_only: false,
        participants: Vec::new(),
        devices: Default::default(),
        mic_level: 0.0,
        mic_test_active: false,
        speaker_test_active: false,
        input_unavailable: false,
        output_unavailable: false,
        gains: BTreeMap::new(),
    };
    let (snapshots_sender, snapshots) = watch::channel(snapshot);
    let (notices_sender, notices) = broadcast::channel(4);
    notices_sender
        .send(VoiceNotice::JoinFailed {
            room: "lobby".into(),
            error: VoiceJoinError::Admission(ApiError::Http {
                status: reqwest::StatusCode::UNAUTHORIZED,
                code: None,
                retry_after: None,
            }),
        })
        .unwrap();
    drop(snapshots_sender);

    let messages = voice_updates(snapshots, notices, scope.clone())
        .collect::<Vec<_>>()
        .await;
    assert!(matches!(
        messages.as_slice(),
        [Message::VoiceNotice(received, VoiceNotice::JoinFailed {
            error: VoiceJoinError::Admission(error),
            ..
        })] if received == &scope && error.is_unauthorized()
    ));
}
