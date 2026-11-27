mod cycles;

use std::{path::Path, sync::Arc};

use falky_core::{
    Origin,
    model::{AccountSession, Participant, Room, SessionGeneration, SessionKind, Visitor},
    voice::VoiceParticipant,
};
use futures_util::{StreamExt, stream};
use iced::{
    Color, Pixels, Rectangle, Renderer, Size,
    advanced::{
        graphics::text::font_system,
        layout::{Layout, Limits},
        renderer::{self, Headless, Renderer as _},
        subscription::into_recipes,
        widget::Tree,
    },
    mouse, window,
};

use super::*;
use crate::{perf, perf_fixture};

const WIDTH: u32 = 1180;
const HEIGHT: u32 = 780;
const SAMPLES: usize = 101;
const EXPECTED_THEME: EffectiveTheme = EffectiveTheme::Dark;
const VIEWPORT: Viewport = Viewport {
    width: WIDTH as f32,
    height: HEIGHT as f32,
};

#[derive(Clone, Copy, PartialEq)]
enum Scene {
    Empty,
    Silent,
    Stage,
    Chat,
    Share,
}

impl Scene {
    const fn name(self) -> &'static str {
        match self {
            Self::Empty => "idle",
            Self::Silent => "voice_silent",
            Self::Stage => "stage",
            Self::Chat => "chat",
            Self::Share => "share",
        }
    }

    fn has_voice(self) -> bool {
        matches!(self, Self::Silent | Self::Stage | Self::Share)
    }
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_scenes() {
    let mut renderer = headless_renderer().await;
    println!("falky-backend {}", renderer.name());

    let preferences = settings::Preferences::default();
    let (platform, _) = platform::Platform::boot(window::Settings::default());
    let mut view = HeadlessView {
        renderer: &mut renderer,
        platform: &platform,
        preferences: &preferences,
    };
    for scene in [Scene::Empty, Scene::Stage, Scene::Chat, Scene::Share] {
        view.run(scene);
    }
}

async fn headless_renderer() -> Renderer {
    {
        let mut fonts = font_system().write().unwrap();
        for font in [shell::ONEST, shell::ONEST_NATIVE, shell::REACTIONS] {
            fonts.load_font(font.into());
        }
    }
    Renderer::new(shell::DEFAULT_FONT, Pixels(16.0), Some("wgpu"))
        .await
        .expect("headless wgpu for stage and inline share")
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_scene_memory() {
    let Ok(name) = std::env::var("FALKY_PERF_SCENE") else {
        return;
    };
    let scene = [Scene::Empty, Scene::Stage, Scene::Chat, Scene::Share]
        .into_iter()
        .find(|scene| scene.name() == name)
        .expect("known scene");
    let mut renderer = headless_renderer().await;
    let preferences = settings::Preferences::default();
    let (platform, _) = platform::Platform::boot(window::Settings::default());
    HeadlessView {
        renderer: &mut renderer,
        platform: &platform,
        preferences: &preferences,
    }
    .run_memory(scene)
    .await;
}

#[tokio::test]
#[ignore = "release scoreboard"]
async fn scoreboard_wakeups() {
    let preferences = settings::Preferences::default();
    for scene in [Scene::Empty, Scene::Silent, Scene::Stage, Scene::Share] {
        let session = fixture(scene, &preferences);
        let subscription = session.shell_subscription(EXPECTED_THEME, Language::En, VIEWPORT);
        let mut ticks_per_second = 0.0;
        for recipe in into_recipes(subscription) {
            let mut events = recipe.stream(Box::pin(stream::empty()));
            let mut previous = None;
            while let Some(event) = tokio::time::timeout(Duration::from_secs(2), events.next())
                .await
                .expect("frame timer or a completed input stream")
            {
                if let Message::Shell(_, shell::Action::Frame(tick)) = event {
                    if let Some(last) = previous {
                        ticks_per_second += 1.0 / tick.duration_since(last).as_secs_f64();
                        break;
                    }
                    previous = Some(tick);
                }
            }
        }
        perf::metric(&format!("wakeups.{}.hz", scene.name()), ticks_per_second);
    }
}

struct HeadlessView<'a> {
    renderer: &'a mut Renderer,
    platform: &'a platform::Platform,
    preferences: &'a settings::Preferences,
}

impl HeadlessView<'_> {
    fn run(&mut self, scene: Scene) {
        let mut session = fixture(scene, self.preferences);
        let pictures = scene_pictures(scene);
        let sample_frame = |index: usize| pictures.as_ref().map(|frames| &frames[index / 2 % 2]);
        let mut tree = Tree::empty();
        let mut phase_samples: [Vec<perf::Sample>; 4] =
            std::array::from_fn(|_| Vec::with_capacity(SAMPLES));

        session
            .shell
            .set_scoreboard_time(Duration::from_millis(731));
        self.draw(&session, &mut tree, sample_frame(0));
        let screenshot = self.screenshot();
        save_screenshot(scene.name(), &screenshot);

        for index in 0..SAMPLES {
            session.shell.set_scoreboard_time(elapsed(index));
            let window = perf::HeapWindow::start();
            let start_bytes = window.start;
            let phases = self.draw(&session, &mut tree, sample_frame(index));
            let total = perf::Sample {
                nanoseconds: phases.iter().map(|sample| sample.nanoseconds).sum(),
                allocations: phases.iter().map(|sample| sample.allocations).sum(),
                peak_bytes: window.finish(),
                residue_bytes: perf::live_bytes() - start_bytes,
                start_bytes,
            };
            for (samples, value) in phase_samples
                .iter_mut()
                .zip(phases.into_iter().chain([total]))
            {
                samples.push(value);
            }
        }
        save_screenshot(&format!("{}.warm", scene.name()), &self.screenshot());

        for (name, samples) in ["build", "layout", "draw", "total"]
            .into_iter()
            .zip(&phase_samples)
        {
            perf::report(&format!("scene.{}.{name}", scene.name()), samples);
        }

        if matches!(scene, Scene::Stage | Scene::Share) {
            let mut total = perf_fixture::GpuWork::default();
            let mut hashes = [0; 8];
            for (index, hash) in hashes.iter_mut().enumerate() {
                session.shell.set_scoreboard_time(elapsed(index + SAMPLES));
                self.draw(&session, &mut tree, sample_frame(index + 2));
                let (pixels, counts) = perf_fixture::gpu_frame(|| self.screenshot());
                *hash = perf::hash(&[&pixels]);
                total.passes += counts.passes;
                total.submissions += counts.submissions;
                total.uploads += counts.uploads;
            }
            for (name, count) in [
                ("render_passes", total.passes),
                ("submissions", total.submissions),
                ("texture_uploads", total.uploads),
            ] {
                perf::metric(
                    &format!("gpu.{}.{name}", scene.name()),
                    count as f64 / hashes.len() as f64,
                );
            }
            perf::golden(
                &format!("scene.{}.playback", scene.name()),
                &[&hashes.map(u64::to_le_bytes).concat()],
            );
        }
    }

    async fn run_memory(&mut self, scene: Scene) {
        let window = perf::HeapWindow::start();
        let start = window.start;
        let mut session = fixture(scene, self.preferences);
        let pictures = scene_pictures(scene);
        let mut tree = Tree::empty();
        let mut retained = 0;
        for frame in 1..=1000 {
            let index = frame - 1;
            session.shell.set_scoreboard_time(elapsed(index));
            let picture = pictures.as_ref().map(|frames| &frames[index / 2 % 2]);
            self.draw(&session, &mut tree, picture);
            if matches!(frame, 1 | 100 | 1000) {
                drop(self.screenshot());
            }
            if frame == 100 {
                retained = perf::live_bytes() - start;
            }
        }
        let growth = (perf::live_bytes() - start - retained) as f64 / 900.0;
        let peak = window.finish();
        #[cfg(target_os = "linux")]
        let process = perf::process_bytes();

        let mut snapshots = session.voice.snapshots();
        drop((session, pictures, tree));
        tokio::time::timeout(Duration::from_secs(2), async {
            while snapshots.changed().await.is_ok() {}
        })
        .await
        .expect("scene voice actor shuts down");
        drop(snapshots);
        self.renderer.reset(Rectangle::with_size(Size::new(
            VIEWPORT.width,
            VIEWPORT.height,
        )));
        drop(self.screenshot());
        let residue = perf::live_bytes() - start;

        let name = scene.name();
        perf::metric(&format!("scene.{name}.heap.retained_bytes"), retained);
        perf::metric(&format!("scene.{name}.heap.peak_bytes"), peak);
        perf::metric(&format!("scene.{name}.heap.residue_bytes"), residue);
        perf::metric(&format!("scene.{name}.heap.growth_bytes_per_frame"), growth);
        #[cfg(target_os = "linux")]
        {
            perf::metric(&format!("scene.{name}.process.pss_anon_bytes"), process.0);
            perf::metric(&format!("scene.{name}.process.vm_hwm_bytes"), process.1);
        }
    }

    fn draw(
        &mut self,
        session: &SignedIn,
        tree: &mut Tree,
        picture: Option<&Arc<dyn shell::PlanarFrame>>,
    ) -> [perf::Sample; 3] {
        let theme = shell::theme(EXPECTED_THEME);
        let size = Size::new(VIEWPORT.width, VIEWPORT.height);
        let bounds = Rectangle::with_size(size);
        let (mut widget, build) = perf::measure(|| {
            let context = ViewContext {
                preferences: self.preferences,
                preferences_unavailable: false,
                platform: self.platform,
                theme: EXPECTED_THEME,
                language: Language::En,
                viewport: VIEWPORT,
                storage_notice: None,
                share_frame: picture,
            };
            session.view(context)
        });
        let (node, layout) = perf::measure(|| {
            tree.diff(widget.as_widget());
            widget
                .as_widget_mut()
                .layout(tree, self.renderer, &Limits::new(Size::ZERO, size))
        });
        let ((), draw) = perf::measure(|| {
            self.renderer.reset(bounds);
            widget.as_widget().draw(
                tree,
                self.renderer,
                &theme,
                &renderer::Style {
                    text_color: theme.palette().text,
                },
                Layout::new(&node),
                mouse::Cursor::Unavailable,
                &bounds,
            );
        });
        [build, layout, draw]
    }

    fn screenshot(&mut self) -> Vec<u8> {
        self.renderer
            .screenshot(Size::new(WIDTH, HEIGHT), 1.0, Color::BLACK)
    }
}

fn scene_pictures(scene: Scene) -> Option<[Arc<dyn shell::PlanarFrame>; 2]> {
    (scene == Scene::Share).then(|| {
        [0, 1].map(|variant| {
            Arc::new(perf_fixture::Picture::new(1920, 1080, variant)) as Arc<dyn shell::PlanarFrame>
        })
    })
}

fn elapsed(index: usize) -> Duration {
    Duration::from_millis(731 + index as u64 * 17)
}

fn save_screenshot(name: &str, pixels: &[u8]) {
    assert_eq!(pixels.len(), WIDTH as usize * HEIGHT as usize * 4);
    let (rgba, _) = pixels.as_chunks::<4>();
    assert!(rgba.iter().any(|pixel| *pixel != rgba[0]));
    perf::golden(&format!("scene.{name}"), &[pixels]);
    if let Some(directory) = std::env::var_os("FALKY_PERF_GOLDENS") {
        let path = Path::new(&directory).join(format!("{name}.png"));
        image::save_buffer(path, pixels, WIDTH, HEIGHT, image::ColorType::Rgba8).unwrap();
    }
}

#[tokio::test]
async fn stage_projection_follows_viewed_room_and_active_voice_participants() {
    let mut session = fixture(Scene::Stage, &settings::Preferences::default());
    session.live.account.visitor.name = "Current profile".into();
    session.live.rooms[0].occupancy[1].name = "Current occupancy".into();
    session.live.rooms[0].occupancy.truncate(2);
    let other = RoomId::from("other");
    session.live.rooms.push(Room {
        id: other.clone(),
        name: "Other".into(),
        occupancy: vec![Participant {
            connection_id: "other-connection".into(),
            visitor_id: "other-visitor".into(),
            name: "Other participant".into(),
        }],
    });
    let changed_connection = ConnectionId::from("reconnected");
    session.participants[1].connection_id = changed_connection.clone();
    session.gains.insert(changed_connection.clone(), 65);

    let stage = session.stage();
    assert_eq!(stage[0].name, "Current profile");
    assert_eq!(stage[1].name, "Current occupancy");
    assert_eq!(stage[1].connection_id, &changed_connection);
    assert_eq!(stage[1].gain_percent, 65);
    assert_eq!(stage[2].name, "Member 3");

    drop(session.chat.select_room(Some(other)));
    let stage = session.stage();
    assert_eq!(stage.len(), 1);
    assert_eq!(stage[0].name, "Other participant");
    assert_eq!(
        stage[0].connection_id,
        &ConnectionId::from("other-connection")
    );
    assert_eq!(stage[0].gain_percent, 100);
    assert!(!stage[0].speaking);
}

fn fixture(scene: Scene, preferences: &settings::Preferences) -> SignedIn {
    let room = RoomId::from("studio");
    let scope = SessionScope {
        origin: Origin::parse("http://127.0.0.1:1").unwrap(),
        generation: SessionGeneration(1),
    };
    let visitor = Visitor {
        id: "visitor-0".into(),
        name: "Member 1".into(),
        name_taken: false,
        colour: VisitorColour {
            visitor_id: "visitor-0".into(),
            palette: PaletteName::Sky,
            revision: 1,
        },
    };
    let account = AccountSession {
        visitor: visitor.clone(),
        kind: SessionKind::Account,
        expires_at: None,
    };
    let api = ApiClient::new(scope.origin.clone()).unwrap();
    let read = ReadState::default();
    let voice = Voice::start(
        scope.clone(),
        api.clone(),
        voice_settings(preferences),
        BTreeMap::new(),
    );
    let mut snapshot = voice.snapshots().borrow().clone();
    let (relevant, _) = watch::channel(vec![visitor.id.clone()]);
    let mut session = SignedIn {
        live: LiveState::new(scope.clone(), account),
        chat: chat::Chat::new(scope, api.clone(), visitor, read.clone()),
        chat_open: scene == Scene::Chat,
        editor_focused: false,
        settings: settings::State::default(),
        shell: shell::State::default(),
        voice,
        voice_status: VoiceStatus::default(),
        audio: settings::AudioStatus::default(),
        gains: BTreeMap::new(),
        flash: None,
        deferred_share_flash: None,
        share: share::Share::default(),
        read_checkpoint: ReadCheckpoint {
            saved: read,
            retry_at: None,
        },
        colour_requests: ColourRequests::default(),
        participants: Vec::new(),
        voice_connection: None,
        voice_reconnecting: false,
        voice_joined: None,
        holds: HashSet::new(),
        relevant,
        _background: std::array::from_fn(|_| Task::<Message>::none().abortable().1),
        api,
    };
    if scene.has_voice() {
        snapshot.room = Some(room.clone());
        snapshot.connection = Some("connection-0".into());
        let count = if scene == Scene::Share { 2 } else { 6 };
        snapshot.participants = (0..count)
            .map(|index| VoiceParticipant {
                connection_id: format!("connection-{index}").into(),
                visitor_id: format!("visitor-{index}").into(),
                name: format!("Member {}", index + 1),
                local: index == 0,
                muted: false,
                deafened: false,
                camera: false,
                screen: scene == Scene::Share && index == 1,
                speaking: scene == Scene::Stage,
                level: if scene == Scene::Stage {
                    0.55 + index as f32 * 0.033
                } else {
                    0.0
                },
            })
            .collect();
        snapshot.watched_share = (scene == Scene::Share).then(|| "connection-1".into());
    }
    let occupancy = snapshot
        .participants
        .iter()
        .map(|person| Participant {
            connection_id: person.connection_id.clone(),
            visitor_id: person.visitor_id.clone(),
            name: person.name.clone(),
        })
        .collect();
    session.live.rooms = vec![Room {
        id: room.clone(),
        name: "Studio".into(),
        occupancy,
    }];
    drop(session.chat.select_room(Some(room.clone())));
    if scene == Scene::Chat {
        drop(session.chat.set_open(true));
        chat::scoreboard::load_timeline(&mut session.chat, &room);
    }
    session.update_voice(snapshot);
    session
}
