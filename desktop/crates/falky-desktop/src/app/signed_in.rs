mod share;

pub(super) use share::{CaptureReady, ViewerScope};

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::Path,
    time::Duration,
};

use falky_core::{
    chat::ReadState,
    live,
    model::{
        ConnectionId, LiveScope, PaletteName, Room, RoomId, SessionScope, VisitorColour, VisitorId,
    },
    session::Authenticated,
    transport::{ApiClient, ApiError},
    voice::{
        HoldSource, Voice, VoiceCommand, VoiceJoinError, VoiceNotice, VoiceSettings, VoiceSnapshot,
    },
};
use futures_util::SinkExt;
use iced::{
    Element, Fill, Subscription, Task, alignment,
    task::Handle,
    time::Instant,
    widget::{Stack, column, container, text},
};
use tokio::sync::{broadcast, mpsc, watch};

use crate::{
    chat, locale, platform, settings, shell,
    ui_contract::{
        AudioDevice, EffectiveTheme, Language, PttAction, PttSource, RoomIndicator, ShellInput,
        StageParticipant, TickerItem, Viewport, VoiceAction, VoiceStatus,
    },
};

use super::{Message, live_state::LiveState};

pub(super) struct SignedIn {
    pub live: LiveState,
    pub api: ApiClient,
    pub chat: chat::Chat,
    pub chat_open: bool,
    pub editor_focused: bool,
    pub settings: settings::State,
    pub shell: shell::State,
    pub voice: Voice,
    pub voice_status: VoiceStatus,
    pub audio: settings::AudioStatus,
    pub gains: BTreeMap<ConnectionId, u16>,
    pub flash: Option<(Instant, Flash)>,
    pub deferred_share_flash: Option<Flash>,
    share: share::Share,
    read_checkpoint: ReadCheckpoint,
    colour_requests: ColourRequests,
    participants: Vec<falky_core::voice::VoiceParticipant>,
    voice_connection: Option<ConnectionId>,
    voice_reconnecting: bool,
    voice_joined: Option<Instant>,
    holds: HashSet<PttSource>,
    relevant: watch::Sender<Vec<VisitorId>>,
    _background: [Handle; 2],
}

#[derive(Clone, Copy)]
pub(super) enum Flash {
    Notice(locale::Key),
    ConnectionLost,
    Away(u16),
}

impl Flash {
    pub fn join_error(error: VoiceJoinError) -> Self {
        use locale::Key;
        let key = match error {
            VoiceJoinError::Admission(error) => match error.code() {
                Some("voice_room_full" | "room_full") => Key::VoiceRoomFull,
                Some("voice_unavailable") => Key::VoiceVoiceUnavailable,
                Some("name_taken") => Key::VoiceNameTaken,
                Some("visitor_required") => Key::VoiceVisitorRequired,
                _ => Key::VoiceJoinFailed,
            },
            VoiceJoinError::Connection | VoiceJoinError::TimedOut => Key::VoiceMediaFailed,
        };
        Self::Notice(key)
    }

    fn label(self, language: Language) -> String {
        use locale::Key;
        match self {
            Self::Notice(key) => locale::text(language, key).to_owned(),
            Self::ConnectionLost => locale::text(language, Key::VoiceLost).to_owned(),
            Self::Away(minutes) => locale::away_muted_body(language, u64::from(minutes)),
        }
    }
}

pub(super) struct ViewContext<'a> {
    pub preferences: &'a settings::Preferences,
    pub preferences_unavailable: bool,
    pub platform: &'a platform::Platform,
    pub theme: EffectiveTheme,
    pub language: Language,
    pub viewport: Viewport,
    pub storage_notice: Option<&'static str>,
}

impl SignedIn {
    pub fn start(
        auth: Authenticated,
        prefs: &settings::Preferences,
        read: ReadState,
    ) -> (Self, Task<Message>) {
        let scope = auth.scope.clone();
        let account = auth.account.clone();
        let api = auth.client.clone();
        let gains: BTreeMap<_, _> = prefs
            .gains(&scope.origin)
            .map(|(id, value)| (id.clone(), value))
            .collect();
        let voice = Voice::start(
            scope.clone(),
            api.clone(),
            voice_settings(prefs),
            gains.clone(),
        );
        voice.command(VoiceCommand::ShareGain(prefs.share_volume.percent()));
        let (relevant, watched) = watch::channel(vec![account.visitor.id.clone()]);
        let (live_task, live_handle) = live_task(auth, watched).abortable();
        let (voice_task, voice_handle) = watch_voice(&voice, scope.clone()).abortable();
        let initial = voice.snapshots().borrow().clone();

        let mut session = Self {
            live: LiveState::new(scope.clone(), account.clone()),
            chat: chat::Chat::new(scope, api.clone(), account.visitor, read.clone()),
            read_checkpoint: ReadCheckpoint {
                saved: read,
                retry_at: None,
            },
            api,
            chat_open: false,
            editor_focused: false,
            settings: settings::State::default(),
            shell: shell::State::default(),
            voice,
            audio: settings::AudioStatus::default(),
            voice_status: VoiceStatus::default(),
            gains,
            colour_requests: ColourRequests::default(),
            flash: None,
            deferred_share_flash: None,
            share: share::Share::default(),
            participants: Vec::new(),
            voice_connection: None,
            voice_reconnecting: false,
            voice_joined: None,
            holds: HashSet::new(),
            relevant,
            _background: [live_handle.abort_on_drop(), voice_handle.abort_on_drop()],
        };
        session.update_voice(initial);
        (session, Task::batch([live_task, voice_task]))
    }

    pub fn room(&self, id: &RoomId) -> Option<&Room> {
        self.live.rooms.iter().find(|room| &room.id == id)
    }

    fn viewed_room(&self) -> Option<&Room> {
        self.chat
            .read_state()
            .viewed_room
            .as_ref()
            .and_then(|id| self.room(id))
    }

    pub fn uses_keyboard(&self) -> bool {
        !self.shell.share_fullscreen()
            && (self.editor_focused
                || self.settings.is_open()
                || self.shell.modal_open()
                || self.chat.modal_open())
    }

    pub fn adjacent_room(&self, forward: bool) -> Option<RoomId> {
        let rooms = &self.live.rooms;
        let total = rooms.len();
        if total == 0 {
            return None;
        }
        let current = self
            .chat
            .read_state()
            .viewed_room
            .as_ref()
            .and_then(|viewed| rooms.iter().position(|room| &room.id == viewed));
        let next = match (current, forward) {
            (Some(index), true) => (index + 1) % total,
            (Some(index), false) => (index + total - 1) % total,
            (None, true) => 0,
            (None, false) => total - 1,
        };
        Some(rooms[next].id.clone())
    }

    pub fn ensure_viewed_room(&mut self) -> Task<chat::Message> {
        let room = self.viewed_room().or_else(|| self.live.rooms.first());
        self.select_room(room.map(|room| room.id.clone()))
    }

    pub fn select_room(&mut self, room: Option<RoomId>) -> Task<chat::Message> {
        if self.chat.read_state().viewed_room != room {
            self.release_dock_hold();
        }
        let task = self.chat.select_room(room);
        self.reconcile_shell();
        task
    }

    fn reconcile_shell(&mut self) {
        self.shell.reconcile(
            self.chat.read_state().viewed_room.as_ref(),
            self.voice_status.room.as_ref(),
            |id| {
                self.participants
                    .iter()
                    .any(|person| !person.local && &person.connection_id == id)
            },
        );
    }

    pub fn save_read(&mut self, path: &Path, quitting: bool) {
        self.read_checkpoint.save(
            self.chat.read_state(),
            path,
            &self.live.scope.origin,
            &self.live.account.visitor.id,
            quitting,
        );
    }

    pub fn reset_colour_requests(&mut self) {
        self.colour_requests = ColourRequests::default();
    }

    pub fn sync_visitors(&mut self) -> Task<Message> {
        let mut ids = self.chat.relevant_visitors();
        ids.insert(self.live.account.visitor.id.clone());
        ids.extend(
            self.live
                .rooms
                .iter()
                .flat_map(|room| &room.occupancy)
                .map(|person| person.visitor_id.clone()),
        );
        ids.extend(
            self.participants
                .iter()
                .map(|person| person.visitor_id.clone()),
        );
        let ids: Vec<_> = ids.into_iter().collect();
        self.relevant.send_if_modified(|current| {
            if *current == ids {
                return false;
            }
            current.clone_from(&ids);
            true
        });

        let Some(socket) = self.live.connected_scope() else {
            return Task::none();
        };
        let missing = ids.into_iter().filter(|id| self.live.palette(id).is_none());
        let requested = self.colour_requests.start(missing, Instant::now());
        if requested.is_empty() {
            return Task::none();
        }
        let client = self.api.clone();
        let socket = socket.clone();
        Task::perform(
            async move {
                let result = live::colours(&client, requested.iter().cloned()).await;
                (requested, result)
            },
            move |(requested, result)| Message::Colours(socket, requested, result),
        )
    }

    pub fn finish_colour_request(
        &mut self,
        socket: &LiveScope,
        requested: Vec<VisitorId>,
        result: Result<Vec<VisitorColour>, ApiError>,
    ) -> Task<Message> {
        match result {
            Ok(assignments) => {
                self.colour_requests.succeeded();
                for assignment in assignments {
                    self.live.merge_colour(assignment);
                }
                self.sync_visitors()
            }
            Err(_) => {
                let delay = self.colour_requests.failed(requested, Instant::now());
                let socket = socket.clone();
                Task::perform(tokio::time::sleep(delay), move |()| {
                    Message::RetryColours(socket)
                })
            }
        }
    }

    pub fn send_settings(&mut self, prefs: &settings::Preferences) {
        if !prefs.voice.push_to_talk {
            self.release_holds();
        }
        self.voice
            .command(VoiceCommand::Settings(voice_settings(prefs)));
    }

    pub fn release_holds(&mut self) {
        self.holds.clear();
        self.voice_status.ptt_held = false;
        self.voice.command(VoiceCommand::ReleaseHolds);
    }

    pub fn release_local_holds(&mut self) {
        self.holds.retain(|source| *source == PttSource::Global);
        self.voice_status.ptt_held = !self.holds.is_empty();
        self.voice.command(VoiceCommand::ReleaseLocalHolds);
    }

    pub fn release_dock_hold(&mut self) {
        if self.holds.remove(&PttSource::Dock) {
            self.voice_status.ptt_held = !self.holds.is_empty();
            self.voice
                .command(VoiceCommand::Hold(HoldSource::DockPointer, false));
        }
    }

    pub fn voice_action(&mut self, action: VoiceAction, ptt_enabled: bool) {
        let command = match action {
            VoiceAction::Join(room) => {
                if self.room(&room).is_none() {
                    return;
                }
                VoiceCommand::Join(room)
            }
            VoiceAction::Leave => {
                self.share.cancel_picker();
                self.release_holds();
                VoiceCommand::Leave
            }
            VoiceAction::ToggleMute => {
                let muted = !self.voice_status.muted;
                if muted {
                    self.release_holds();
                }
                VoiceCommand::SetMuted(muted)
            }
            VoiceAction::ToggleDeafen => VoiceCommand::SetDeafened(!self.voice_status.deafened),
            VoiceAction::PushToTalk(PttAction { source, pressed }) => {
                if pressed
                    && (!ptt_enabled
                        || self.voice_status.room.is_none()
                        || self.voice_status.deafened
                        || self.voice_status.listen_only
                        || self.voice_reconnecting)
                {
                    return;
                }
                if pressed {
                    self.holds.insert(source);
                } else {
                    self.holds.remove(&source);
                }
                self.voice_status.ptt_held = !self.holds.is_empty();
                let source = match source {
                    PttSource::Global => HoldSource::Global,
                    PttSource::Window => HoldSource::InApp,
                    PttSource::Dock => HoldSource::DockPointer,
                };
                VoiceCommand::Hold(source, pressed)
            }
            VoiceAction::SetGain {
                connection_id,
                percent,
            } => VoiceCommand::Gain(connection_id, percent),
        };
        self.voice.command(command);
    }

    pub fn voice_roster_changed(&self, snapshot: &VoiceSnapshot) -> bool {
        self.participants.len() != snapshot.participants.len()
            || self
                .participants
                .iter()
                .zip(&snapshot.participants)
                .any(|(before, after)| before.visitor_id != after.visitor_id)
    }

    pub fn update_voice(&mut self, snapshot: VoiceSnapshot) {
        let call_changed = self.voice_connection != snapshot.connection;
        if call_changed {
            self.voice_joined = snapshot.connection.as_ref().map(|_| Instant::now());
            self.shell.update(shell::Action::Dismiss);
        }
        self.share.snapshot(&snapshot, call_changed);
        if call_changed || snapshot.deafened || snapshot.listen_only || snapshot.reconnecting {
            self.holds.clear();
        }
        self.voice_connection = snapshot.connection;
        self.voice_reconnecting = snapshot.reconnecting;
        self.voice_status = VoiceStatus {
            room: snapshot.room,
            joining: snapshot.joining,
            muted: snapshot.muted,
            deafened: snapshot.deafened,
            ptt_held: !self.holds.is_empty(),
            listen_only: snapshot.listen_only,
            mic_level: snapshot.mic_level,
        };
        let device = |device: falky_core::audio::AudioDevice| AudioDevice {
            id: device.id,
            name: device.name,
        };
        self.audio = settings::AudioStatus {
            inputs: snapshot.devices.input.into_iter().map(device).collect(),
            outputs: snapshot.devices.output.into_iter().map(device).collect(),
            mic_level: snapshot.mic_level,
            mic_test_active: snapshot.mic_test_active,
            speaker_test_active: snapshot.speaker_test_active,
            input_unavailable: snapshot.input_unavailable,
            output_unavailable: snapshot.output_unavailable,
            in_voice: self.voice_status.room.is_some(),
            muted: snapshot.muted,
        };
        self.participants = snapshot.participants;
        self.gains = snapshot.gains;
        self.reconcile_shell();
    }

    pub fn sync_share(&mut self, window_visible: bool) {
        if !window_visible {
            self.share.cancel_picker();
        }
        if let Some(command) = self.share.update_video_visibility(
            window_visible,
            self.chat.read_state().viewed_room.as_ref(),
            self.voice_status.room.as_ref(),
        ) {
            self.voice.command(command);
        }
        if !self.share.video_visible() || self.share.watched.is_none() {
            self.shell.exit_share_fullscreen();
        }
    }

    pub fn viewing_call(&self) -> bool {
        share::viewing_call(
            self.chat.read_state().viewed_room.as_ref(),
            self.voice_status.room.as_ref(),
        )
    }

    fn viewer_scope(&self) -> Option<ViewerScope> {
        Some(ViewerScope {
            call: self.voice_connection.clone()?,
            selected: self.share.watched.clone(),
        })
    }

    pub fn accepts_viewer(&self, source: &ViewerScope) -> bool {
        let snapshots = self.voice.snapshots();
        let current = snapshots.borrow();
        self.viewing_call()
            && source.matches(self.voice_connection.as_ref(), self.share.watched.as_ref())
            && source.matches(current.connection.as_ref(), current.watched_share.as_ref())
    }

    pub fn can_stop_sharing(&self) -> bool {
        self.share.can_stop()
    }

    pub fn stop_sharing(&mut self) {
        self.share.stop(&self.voice);
    }

    pub fn share_failed(&mut self) {
        self.share.failed();
    }

    pub fn toggle_capture(
        &mut self,
        window: Option<iced::window::Id>,
        preferences: settings::ShareSettings,
    ) -> Task<Message> {
        match self.share.status(self.voice_connection.is_some()) {
            shell::ShareCaptureStatus::Idle => {
                if let (Some(window), Some(connection)) = (window, self.voice_connection.clone()) {
                    return self.share.start(
                        window,
                        self.live.scope.clone(),
                        connection,
                        preferences,
                    );
                }
            }
            shell::ShareCaptureStatus::Sharing => self.stop_sharing(),
            _ => {}
        }
        Task::none()
    }

    pub fn finish_capture(&mut self, ready: CaptureReady) -> Option<Flash> {
        self.share
            .finish(&self.voice, self.voice_connection.as_ref(), ready)
            .map(Flash::Notice)
    }

    fn rooms(&self) -> Vec<RoomIndicator> {
        self.live
            .rooms
            .iter()
            .map(|room| RoomIndicator {
                id: room.id.clone(),
                name: room.name.clone(),
                occupancy: room.occupancy.len(),
                viewed: self.chat.read_state().viewed_room.as_ref() == Some(&room.id),
                in_voice: self.voice_status.room.as_ref() == Some(&room.id),
                unread: self.chat.unread(&room.id),
            })
            .collect()
    }

    fn stage(&self) -> Vec<StageParticipant> {
        let Some(room) = self.viewed_room() else {
            return Vec::new();
        };
        let palette = |id: &VisitorId| self.live.palette(id).unwrap_or(PaletteName::Sky);
        let local_id = &self.live.account.visitor.id;
        let local_name = &self.live.account.visitor.name;
        if self.voice_status.room.as_ref() == Some(&room.id) {
            return self
                .participants
                .iter()
                .map(|person| StageParticipant {
                    connection_id: person.connection_id.clone(),
                    visitor_id: person.visitor_id.clone(),
                    name: if person.local {
                        local_name
                    } else {
                        room.occupancy
                            .iter()
                            .find(|occupant| occupant.visitor_id == person.visitor_id)
                            .map_or(&person.name, |occupant| &occupant.name)
                    }
                    .clone(),
                    palette: palette(&person.visitor_id),
                    local: person.local,
                    muted: person.muted,
                    deafened: person.deafened,
                    speaking: person.speaking,
                    level: person.level,
                    camera: person.camera,
                    screen_share: person.screen,
                    gain_percent: self
                        .gains
                        .get(&person.connection_id)
                        .copied()
                        .unwrap_or(100),
                })
                .collect();
        }

        room.occupancy
            .iter()
            .map(|person| StageParticipant {
                connection_id: person.connection_id.clone(),
                visitor_id: person.visitor_id.clone(),
                name: person.name.clone(),
                palette: palette(&person.visitor_id),
                local: &person.visitor_id == local_id,
                muted: false,
                deafened: false,
                speaking: false,
                level: 0.0,
                camera: false,
                screen_share: false,
                gain_percent: 100,
            })
            .collect()
    }

    pub fn shell_subscription(
        &self,
        theme: EffectiveTheme,
        language: Language,
        viewport: Viewport,
    ) -> Subscription<Message> {
        let scope = self.live.scope.clone();
        self.shell
            .subscription_with_share(
                ShellInput {
                    theme,
                    language,
                    rooms: &[],
                    stage: &self.stage(),
                    voice: &self.voice_status,
                    ticker: &[],
                    chat_open: self.chat_open,
                    viewport,
                },
                true,
                self.viewing_call() && self.share.watched.is_some(),
            )
            .with((scope, self.viewer_scope()))
            .map(|((scope, viewer), action)| share::shell_message(scope, viewer.as_ref(), action))
    }

    pub fn view<'a>(&'a self, context: ViewContext<'a>) -> Element<'a, Message> {
        let ViewContext {
            preferences,
            preferences_unavailable,
            platform,
            theme,
            language,
            viewport,
            storage_notice,
        } = context;
        let scope = &self.live.scope;
        let rooms = self.rooms();
        let stage = self.stage();
        let ticker: Vec<TickerItem> = self.chat.ticker(language);
        let senders = self.chat.ticker_visitors();
        let ticker_senders: Vec<_> = senders
            .iter()
            .map(|id| shell::TickerSender {
                identity: id.as_str(),
                palette: self.live.palette(id),
            })
            .collect();
        let names: Vec<_> = self
            .live
            .rooms
            .iter()
            .map(|room| {
                room.occupancy
                    .iter()
                    .map(|person| person.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .collect();
        let room_people: Vec<_> = self
            .live
            .rooms
            .iter()
            .zip(&names)
            .map(|(room, names)| shell::RoomPeople {
                room: &room.id,
                names,
            })
            .collect();

        let chat = self.chat_open.then(|| {
            let room = self.viewed_room().map_or("", |room| room.name.as_str());
            self.chat
                .view_with_colours(room, language, theme, &|id| {
                    self.live
                        .palette(id)
                        .map(|palette| shell::style::identity_name(palette, theme))
                })
                .map(move |message| Message::Chat(scope.clone(), message))
        });
        let notice = if self.live.reconnecting {
            Some(shell::ConnectionNotice::Reconnecting)
        } else if self.voice_reconnecting {
            Some(shell::ConnectionNotice::ReconnectingVoice)
        } else {
            None
        };
        let selected = self.share.watched.as_ref().filter(|_| self.viewing_call());
        let frame = selected
            .and_then(|connection| self.voice.latest_share_frame(connection))
            .map(|frame| frame as std::sync::Arc<dyn shell::PlanarFrame>);
        let viewer = self.viewer_scope();
        let shell = shell::view_with_share(
            &self.shell,
            ShellInput {
                theme,
                language,
                rooms: &rooms,
                stage: &stage,
                voice: &self.voice_status,
                ticker: &ticker,
                chat_open: self.chat_open,
                viewport,
            },
            shell::Details {
                push_to_talk: preferences.voice.push_to_talk,
                joined_at: self.voice_joined,
                notice,
                room_people: &room_people,
                ticker_senders: &ticker_senders,
                ..shell::Details::default()
            },
            shell::ShareView {
                selected,
                frame,
                volume: preferences.share_volume.percent(),
                capture: self.share.status(self.voice_connection.is_some()),
            },
            chat,
            move |action| share::shell_message(scope.clone(), viewer.as_ref(), action),
        );
        let mut layers = Stack::new().push(shell);
        if storage_notice.is_some() || self.flash.is_some() {
            let mut messages = column![].spacing(6).align_x(alignment::Horizontal::Center);
            let colors = shell::style::Colors::new(theme);
            let badge = move |label: String| {
                container(text(label).size(13).color(colors.text))
                    .padding([7, 12])
                    .style(move |_| container::Style::default().background(colors.surface))
            };
            if let Some(notice) = storage_notice {
                messages = messages.push(badge(notice.into()));
            }
            if let Some((_, flash)) = self.flash {
                messages = messages.push(badge(flash.label(language)));
            }
            layers = layers.push(container(messages).center_x(Fill).padding([64, 16]));
        }
        if let Some(modal) = self.chat.modal(language, theme) {
            layers = layers.push(modal.map(move |message| Message::Chat(scope.clone(), message)));
        }
        if self.settings.is_open() {
            layers = layers.push(
                settings::view_with_share(
                    &self.settings,
                    settings::Props {
                        prefs: preferences,
                        account: &self.live.account,
                        origin: &scope.origin,
                        audio: &self.audio,
                        theme,
                        language,
                        viewport,
                        global_ptt: platform.global_ptt_status(),
                        global_binding: platform.global_ptt_trigger(),
                        preferences_unavailable,
                        palette: shell::style::palette,
                    },
                    share::settings_status(self.share.sharing),
                )
                .map(move |message| Message::Settings(scope.clone(), message)),
            );
        }
        layers.into()
    }
}

fn voice_settings(prefs: &settings::Preferences) -> VoiceSettings {
    let voice = &prefs.voice;
    VoiceSettings {
        mic_id: voice.mic_id.clone(),
        speaker_id: voice.speaker_id.clone(),
        echo_cancellation: voice.echo_cancellation,
        noise_suppression: voice.noise_suppression,
        auto_gain: voice.auto_gain,
        join_muted: voice.join_muted,
        push_to_talk: voice.push_to_talk,
        away_mute: voice.away_mute,
        away_minutes: (voice.away_minutes.duration().as_secs() / 60) as u16,
        chimes: prefs.chimes,
    }
}

fn live_task(auth: Authenticated, relevant: watch::Receiver<Vec<VisitorId>>) -> Task<Message> {
    Task::stream(iced::stream::channel::<Message>(
        32,
        async move |mut output| {
            let (sender, mut notices) = mpsc::channel(32);
            let consume = async move {
                while let Some(notice) = notices.recv().await {
                    if output.send(Message::Live(Box::new(notice))).await.is_err() {
                        break;
                    }
                }
            };
            tokio::join!(live::run(auth, relevant, sender), consume);
        },
    ))
}

struct ReadCheckpoint {
    saved: ReadState,
    retry_at: Option<Instant>,
}

impl ReadCheckpoint {
    fn save(
        &mut self,
        read: &ReadState,
        path: &Path,
        origin: &falky_core::Origin,
        visitor: &VisitorId,
        quitting: bool,
    ) {
        let now = Instant::now();
        if read == &self.saved || (!quitting && self.retry_at.is_some_and(|next| now < next)) {
            return;
        }
        if read.save(path, origin, visitor).is_ok() {
            self.saved.clone_from(read);
            self.retry_at = None;
        } else {
            self.retry_at = Some(now + Duration::from_secs(1));
        }
    }
}

#[derive(Default)]
struct ColourRequests {
    attempted: BTreeSet<VisitorId>,
    in_flight: bool,
    retry_after: Option<Instant>,
    failures: u32,
}

impl ColourRequests {
    fn start(&mut self, missing: impl Iterator<Item = VisitorId>, now: Instant) -> Vec<VisitorId> {
        if self.in_flight || self.retry_after.is_some_and(|next| now < next) {
            return Vec::new();
        }
        let ids: Vec<_> = missing
            .filter(|id| self.attempted.insert(id.clone()))
            .collect();
        self.in_flight = !ids.is_empty();
        ids
    }

    fn succeeded(&mut self) {
        self.in_flight = false;
        self.retry_after = None;
        self.failures = 0;
    }

    fn failed(&mut self, ids: Vec<VisitorId>, now: Instant) -> Duration {
        for id in ids {
            self.attempted.remove(&id);
        }
        self.in_flight = false;
        let delay = Duration::from_secs(1 << self.failures);
        self.failures = (self.failures + 1).min(3);
        self.retry_after = Some(now + delay);
        delay
    }
}

fn watch_voice(voice: &Voice, scope: SessionScope) -> Task<Message> {
    Task::stream(voice_updates(voice.snapshots(), voice.notices(), scope))
}

fn voice_updates(
    mut snapshots: watch::Receiver<VoiceSnapshot>,
    mut notices: broadcast::Receiver<VoiceNotice>,
    scope: SessionScope,
) -> impl futures_util::Stream<Item = Message> {
    iced::stream::channel::<Message>(16, async move |mut output| {
        loop {
            let message = tokio::select! {
                biased;
                change = snapshots.changed() => {
                    if change.is_err() {
                        // The actor may publish a terminal admission 401 before closing snapshots.
                        loop {
                            match notices.try_recv() {
                                Ok(notice) => {
                                    if output.send(Message::VoiceNotice(scope.clone(), notice)).await.is_err() {
                                        return;
                                    }
                                }
                                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                                Err(_) => break,
                            }
                        }
                        break;
                    }
                    Message::VoiceSnapshot(Box::new(snapshots.borrow_and_update().clone()))
                }
                notice = notices.recv() => match notice {
                    Ok(notice) => Message::VoiceNotice(scope.clone(), notice),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            };
            if output.send(message).await.is_err() {
                break;
            }
        }
    })
}

#[cfg(test)]
mod tests;
