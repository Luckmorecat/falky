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
    let mut session = fixture(Scene::Empty, &settings::Preferences::default());
    let mut snapshots = session.voice.snapshots();
    reset_gain(&mut session, &mut snapshots, &"gain-warmup".into()).await;

    let mut next = 0;
    cycles("voice_gain_reset", async || {
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
