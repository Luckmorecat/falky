use super::*;
use crate::{app::App, ui_contract::ShellAction};

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_app_cycles() {
    let studio = RoomId::from("studio");
    let away = RoomId::from("away");
    let mut app = app_fixture(Scene::Chat);
    let session = app.signed_in.as_mut().unwrap();
    session.live.rooms.push(Room {
        id: away.clone(),
        name: "Away".into(),
        occupancy: vec![],
    });
    select_room(&mut app, &away);
    cycles("room", async || {
        select_room(&mut app, &studio);
        select_room(&mut app, &away);
    })
    .await;

    let mut app = app_fixture(Scene::Stage);
    let (left, joined) = voice_snapshots(app.signed_in.as_ref().unwrap());
    assert_eq!(joined.participants.len(), 6);
    apply_voice(&mut app, &left);
    tokio::task::yield_now().await;
    cycles("voice", async || {
        apply_voice(&mut app, &joined);
        assert_eq!(app.signed_in.as_ref().unwrap().participants.len(), 6);
        apply_voice(&mut app, &left);
        assert!(app.signed_in.as_ref().unwrap().participants.is_empty());
        tokio::task::yield_now().await;
    })
    .await;

    let mut app = app_fixture(Scene::Chat);
    let image = falky_core::model::AttachmentId::from("attachment-39");
    cycles("image_viewer", async || {
        update_chat(&mut app, chat::Message::OpenImage(image.clone()));
        assert!(app.signed_in.as_ref().unwrap().chat.modal_open());
        let reply =
            chat::scoreboard::image_reply(&app.signed_in.as_ref().unwrap().chat, image.clone());
        update_chat(&mut app, reply);
        update_chat(&mut app, chat::Message::CloseModal);
        assert!(!app.signed_in.as_ref().unwrap().chat.modal_open());
    })
    .await;

    let pixels = perf::packed_pixels(3840, 2160, 3840 * 4);
    cycles("clipboard_cancel", async || {
        update_chat(&mut app, chat::Message::Paste);
        let reply = chat::scoreboard::paste_reply(
            &app.signed_in.as_ref().unwrap().chat,
            studio.clone(),
            pixels.clone(),
        );
        let scope = app.signed_in.as_ref().unwrap().live.scope.clone();
        let upload = app.update(Message::Chat(scope, reply));
        let chat = &app.signed_in.as_ref().unwrap().chat;
        let draft = chat::scoreboard::only_draft(chat, &studio);
        let reply = chat::scoreboard::completion(
            chat,
            chat::Work::Uploaded(studio.clone(), draft, Err(ApiError::Transport)),
        );
        update_chat(&mut app, chat::Message::RemoveDraft(draft));
        drop(upload);
        update_chat(&mut app, reply);
    })
    .await;
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_voice_gain_reset() {
    voice_gain_reset("voice_gain_reset", 1).await;
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_voice_gain_reset_warm() {
    voice_gain_reset("voice_gain_reset_warm", 128).await;
}

async fn voice_gain_reset(name: &str, warmup: usize) {
    let mut session = fixture(Scene::Empty, &settings::Preferences::default());
    let mut snapshots = session.voice.snapshots();
    {
        let connection = "gain-warmup".into();
        for _ in 0..warmup {
            reset_gain(&mut session, &mut snapshots, &connection).await;
        }
    }

    let mut next = 0;
    cycles(name, async || {
        next += 1;
        let connection = format!("gain-fixture-{next:08}").into();
        reset_gain(&mut session, &mut snapshots, &connection).await;
    })
    .await;
}

async fn reset_gain(
    session: &mut SignedIn,
    snapshots: &mut watch::Receiver<VoiceSnapshot>,
    connection: &ConnectionId,
) {
    for percent in [75, 100] {
        assert!(
            session
                .voice
                .command(VoiceCommand::Gain(connection.clone(), percent))
        );
        let snapshot = tokio::time::timeout(
            Duration::from_secs(2),
            snapshots.wait_for(|snapshot| {
                snapshot.gains.get(connection).copied().unwrap_or(100) == percent
            }),
        )
        .await
        .expect("voice actor publishes a gain change")
        .expect("voice actor remains active")
        .clone();
        session.update_voice(snapshot);
    }
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_saved_voice_gains() {
    const SAVED_GAINS: usize = 2_500;
    let mut preferences = settings::Preferences::default();
    let mut session = fixture(Scene::Empty, &preferences);
    let scope = session.live.scope.clone();
    for index in 0..SAVED_GAINS {
        let id = format!("b18c2e3f-3c6c-4f72-a3c5-{index:012x}").into();
        let percent = if index % 2 == 0 { 75 } else { 125 };
        preferences.set_gain(&scope.origin, id, percent);
    }
    let settings = voice_settings(&preferences);

    let window = perf::HeapWindow::start();
    let gains = preferences
        .gains(&scope.origin)
        .map(|(id, gain)| (id.clone(), gain))
        .collect();
    let voice = Voice::start(scope, session.api.clone(), settings, gains);
    let snapshots = voice.snapshots();
    let initial = snapshots.borrow().clone();
    session.update_voice(initial);
    let retained = perf::live_bytes() - window.start;
    let peak = window.finish();
    perf::metric("voice.saved_gains.retained_bytes", retained);
    perf::metric("voice.saved_gains.peak_bytes", peak);

    assert_eq!(session.gains.len(), SAVED_GAINS);
    assert!(
        preferences
            .gains(&session.live.scope.origin)
            .all(|(id, gain)| { session.gains.get(id) == Some(&gain) })
    );
    drop(perf::repeat("voice.saved_gains.snapshot", 31, || {
        snapshots.borrow().clone()
    }));
    drop(voice);
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_share_cycles() {
    let mut renderer = headless_renderer().await;
    let preferences = settings::Preferences::default();
    let (platform, _) = platform::Platform::boot(window::Settings::default());
    let mut view = HeadlessView {
        renderer: &mut renderer,
        platform: &platform,
        preferences: &preferences,
    };
    let mut tree = Tree::empty();
    let mut app = app_fixture(Scene::Share);
    let (_, mut joined) = voice_snapshots(app.signed_in.as_ref().unwrap());
    joined.watched_share = None;
    let mut watching = joined.clone();
    watching.watched_share = Some("connection-1".into());
    apply_voice(&mut app, &joined);

    cycles("watch_share", async || {
        apply_voice(&mut app, &watching);
        share_frame(&mut view, &app, &mut tree, 1920, 1080);
        apply_voice(&mut app, &joined);
        view.draw(app.signed_in.as_ref().unwrap(), &mut tree, None);
        drop(view.screenshot());
    })
    .await;

    apply_voice(&mut app, &watching);
    share_frame(&mut view, &app, &mut tree, 1920, 1080);
    cycles("share_resolution", async || {
        share_frame(&mut view, &app, &mut tree, 3840, 2160);
        share_frame(&mut view, &app, &mut tree, 1920, 1080);
    })
    .await;
}

fn share_frame(view: &mut HeadlessView<'_>, app: &App, tree: &mut Tree, width: u32, height: u32) {
    let picture: Arc<dyn shell::PlanarFrame> =
        Arc::new(perf_fixture::Picture::new(width, height, 0));
    let session = app.signed_in.as_ref().unwrap();
    assert!(session.share.watched.is_some());
    view.draw(session, tree, Some(&picture));
    drop(view.screenshot());
}

fn app_fixture(scene: Scene) -> App {
    let (mut app, _) = App::boot();
    app.preferences = settings::Preferences::default();
    app.read_path = None;
    app.signed_in = Some(fixture(scene, &app.preferences));
    app
}

fn select_room(app: &mut App, room: &RoomId) {
    let scope = app.signed_in.as_ref().unwrap().live.scope.clone();
    drop(app.update(Message::Shell(
        scope,
        shell::Action::Intent(ShellAction::ViewRoom(room.clone())),
    )));
    assert_eq!(
        app.signed_in
            .as_ref()
            .unwrap()
            .chat
            .read_state()
            .viewed_room
            .as_ref(),
        Some(room),
    );
}

fn voice_snapshots(session: &SignedIn) -> (VoiceSnapshot, VoiceSnapshot) {
    let left = session.voice.snapshots().borrow().clone();
    let mut joined = left.clone();
    joined.room.clone_from(&session.voice_status.room);
    joined.connection.clone_from(&session.voice_connection);
    joined.participants.clone_from(&session.participants);
    (left, joined)
}

fn apply_voice(app: &mut App, snapshot: &VoiceSnapshot) {
    drop(app.update(Message::VoiceSnapshot(Box::new(snapshot.clone()))));
}

fn update_chat(app: &mut App, message: chat::Message) {
    let scope = app.signed_in.as_ref().unwrap().live.scope.clone();
    drop(app.update(Message::Chat(scope, message)));
}

async fn cycles(name: &str, mut update: impl AsyncFnMut()) {
    let window = perf::HeapWindow::start();
    let start = window.start;
    let mut first = 0;
    let mut fifth = 0;
    for cycle in 1..=50 {
        update().await;
        if cycle == 1 {
            first = perf::live_bytes() - start;
        }
        if cycle == 5 {
            fifth = perf::live_bytes() - start;
        }
    }
    let last = perf::live_bytes() - start;
    let peak = window.finish();
    perf::metric(&format!("cycle.{name}.residue_5_bytes"), fifth);
    perf::metric(&format!("cycle.{name}.residue_50_bytes"), last);
    perf::metric(
        &format!("cycle.{name}.growth_5_bytes_per_cycle"),
        (fifth - first) as f64 / 4.0,
    );
    perf::metric(
        &format!("cycle.{name}.growth_50_bytes_per_cycle"),
        (last - fifth) as f64 / 45.0,
    );
    perf::metric(&format!("cycle.{name}.peak_bytes"), peak);
}
