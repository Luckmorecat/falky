//! Scoped voice admission, participant state and a single native audio pipeline.

mod media;
mod policy;
mod screen_capture;
mod share_policy;
mod share_publish;
mod share_receive;
mod transport;

pub use screen_capture::{ScreenCapture, ScreenCaptureSink, ShareFrame, screen_capture};
pub use share_publish::{ShareCodec, ShareFocus, SharePublishSettings, supported_share_codecs};

use crate::{
    audio::{
        AudioDevices, AudioIo, Chime, Cue, DeviceConfig, Mix, SILENCE, gain_percent, pcm_loudness,
    },
    model::{ConnectionId, RoomId, SessionScope, VisitorId, VoiceCredentials},
    transport::{ApiClient, ApiError, Method},
};
use livekit::prelude::{ConnectionState, Room, RoomEvent, RoomOptions};
use media::{MediaRoom, Processor, smooth};
use policy::MicPolicy;
use share_receive::ShareFrames;
use std::{collections::BTreeMap, future::pending, sync::Arc, time::Duration};
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    time::{Instant, MissedTickBehavior, interval, timeout, timeout_at},
};
use url::Url;

const JOIN_TIMEOUT: Duration = Duration::from_secs(20);
const FRAME_TIME: Duration = Duration::from_millis(10);
const UI_TICK: Duration = Duration::from_millis(67);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoiceSettings {
    pub mic_id: String,
    pub speaker_id: String,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain: bool,
    pub join_muted: bool,
    pub push_to_talk: bool,
    pub away_mute: bool,
    pub away_minutes: u16,
    pub chimes: bool,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            mic_id: String::new(),
            speaker_id: String::new(),
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain: true,
            join_muted: false,
            push_to_talk: false,
            away_mute: true,
            away_minutes: 10,
            chimes: true,
        }
    }
}

impl VoiceSettings {
    fn validated(mut self) -> Self {
        if !matches!(self.away_minutes, 5 | 10 | 30) {
            self.away_minutes = Self::default().away_minutes;
        }
        self
    }

    fn processing(&self) -> (bool, bool, bool) {
        (
            self.echo_cancellation,
            self.noise_suppression,
            self.auto_gain,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HoldSource {
    Global,
    InApp,
    DockPointer,
    DockKey,
}

#[derive(Clone, Debug)]
pub enum VoiceCommand {
    Join(RoomId),
    Leave,
    SetMuted(bool),
    SetDeafened(bool),
    Hold(HoldSource, bool),
    ReleaseLocalHolds,
    ReleaseHolds,
    Settings(VoiceSettings),
    RefreshDevices,
    MicTest(bool),
    SpeakerTest,
    Gain(ConnectionId, u16),
    WatchShare {
        call: ConnectionId,
        expected: Option<ConnectionId>,
        target: ConnectionId,
    },
    DismissShare {
        call: ConnectionId,
        expected: Option<ConnectionId>,
    },
    ShareVideoVisible(bool),
    ShareGain(u16),
    StopSharing,
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum VoiceJoinError {
    #[error(transparent)]
    Admission(#[from] ApiError),
    #[error("Could not connect to voice.")]
    Connection,
    #[error("Joining voice timed out.")]
    TimedOut,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoiceNotice {
    JoinFailed { room: RoomId, error: VoiceJoinError },
    AwayMuted { minutes: u16 },
    Disconnected,
    ShareSourceLost,
    SharePublishFailed,
    ShareAudioUnavailable,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceParticipant {
    pub connection_id: ConnectionId,
    pub visitor_id: VisitorId,
    pub name: String,
    pub local: bool,
    pub muted: bool,
    pub deafened: bool,
    pub camera: bool,
    pub screen: bool,
    pub speaking: bool,
    pub level: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VoiceSnapshot {
    pub scope: SessionScope,
    pub room: Option<RoomId>,
    pub joining: Option<RoomId>,
    pub connection: Option<ConnectionId>,
    pub reconnecting: bool,
    pub muted: bool,
    pub deafened: bool,
    pub listen_only: bool,
    pub participants: Vec<VoiceParticipant>,
    pub devices: AudioDevices,
    pub mic_level: f32,
    pub mic_test_active: bool,
    pub speaker_test_active: bool,
    pub input_unavailable: bool,
    pub output_unavailable: bool,
    pub gains: BTreeMap<ConnectionId, u16>,
    pub watched_share: Option<ConnectionId>,
    pub sharing: bool,
    pub publishing_share: bool,
    pub share_gain: u16,
}

impl VoiceSnapshot {
    fn new(scope: SessionScope, mut gains: BTreeMap<ConnectionId, u16>) -> Self {
        for gain in gains.values_mut() {
            *gain = gain_percent(*gain);
        }
        Self {
            scope,
            room: None,
            joining: None,
            connection: None,
            reconnecting: false,
            muted: true,
            deafened: false,
            listen_only: false,
            participants: Vec::new(),
            devices: AudioDevices::default(),
            mic_level: 0.0,
            mic_test_active: false,
            speaker_test_active: false,
            input_unavailable: false,
            output_unavailable: false,
            gains,
            watched_share: None,
            sharing: false,
            publishing_share: false,
            share_gain: 100,
        }
    }
}

/// A voice actor for one authenticated session generation. Start it on a Tokio runtime.
#[derive(Clone)]
pub struct Voice {
    commands: mpsc::UnboundedSender<Request>,
    snapshots: watch::Receiver<VoiceSnapshot>,
    notices: broadcast::Sender<VoiceNotice>,
    share_frames: ShareFrames,
}

impl Voice {
    pub fn start(
        scope: SessionScope,
        api: ApiClient,
        settings: VoiceSettings,
        gains: BTreeMap<ConnectionId, u16>,
    ) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let state = VoiceSnapshot::new(scope, gains);
        let (updates, snapshots) = watch::channel(state.clone());
        let (notices, _) = broadcast::channel(16);
        let actor = Actor::new(
            api,
            settings,
            state,
            updates,
            notices.clone(),
            AudioIo::new(),
        );
        let share_frames = actor.share_frames.clone();
        tokio::spawn(actor.run(receiver));
        Self {
            commands,
            snapshots,
            notices,
            share_frames,
        }
    }

    pub fn command(&self, command: VoiceCommand) -> bool {
        self.commands.send(Request::Command(command)).is_ok()
    }

    /// Queue handoff of the native capture guard for this connection.
    /// The guard is dropped when the connection is obsolete or the share stops.
    pub fn start_share(
        &self,
        connection: ConnectionId,
        capture: ScreenCapture,
        session: Box<dyn Send>,
        settings: SharePublishSettings,
        with_audio: bool,
    ) -> bool {
        self.commands
            .send(Request::Capture {
                connection,
                capture,
                session,
                settings,
                with_audio,
            })
            .is_ok()
    }

    pub fn latest_share_frame(&self, connection: &ConnectionId) -> Option<Arc<ShareFrame>> {
        self.share_frames.get(connection)
    }

    pub fn snapshots(&self) -> watch::Receiver<VoiceSnapshot> {
        self.snapshots.clone()
    }

    pub fn notices(&self) -> broadcast::Receiver<VoiceNotice> {
        self.notices.subscribe()
    }
}

enum Request {
    Command(VoiceCommand),
    Capture {
        connection: ConnectionId,
        capture: ScreenCapture,
        session: Box<dyn Send>,
        settings: SharePublishSettings,
        with_audio: bool,
    },
}

struct Joining {
    room: RoomId,
    result: oneshot::Receiver<Result<Admitted, VoiceJoinError>>,
    deadline: Instant,
}

struct Admitted {
    room: Arc<Room>,
    events: mpsc::UnboundedReceiver<RoomEvent>,
    connection: ConnectionId,
    accepted: oneshot::Sender<()>,
}

struct Call {
    media: MediaRoom,
    policy: MicPolicy,
}

struct Actor {
    api: ApiClient,
    settings: VoiceSettings,
    state: VoiceSnapshot,
    updates: watch::Sender<VoiceSnapshot>,
    notices: broadcast::Sender<VoiceNotice>,
    audio: AudioIo,
    processor: Option<Processor>,
    active: Option<Call>,
    joining: Option<Joining>,
    mic_test: bool,
    chime: Option<Chime>,
    output_tail: Option<Instant>,
    speaker_test_failed: bool,
    mic_level: f32,
    last_capture: Option<Instant>,
    share_frames: ShareFrames,
    share_video_visible: bool,
}

impl Actor {
    fn new(
        api: ApiClient,
        settings: VoiceSettings,
        state: VoiceSnapshot,
        updates: watch::Sender<VoiceSnapshot>,
        notices: broadcast::Sender<VoiceNotice>,
        audio: AudioIo,
    ) -> Self {
        Self {
            api,
            settings: settings.validated(),
            state,
            updates,
            notices,
            audio,
            processor: None,
            active: None,
            joining: None,
            mic_test: false,
            chime: None,
            output_tail: None,
            speaker_test_failed: false,
            mic_level: 0.0,
            last_capture: None,
            share_frames: ShareFrames::default(),
            share_video_visible: true,
        }
    }

    async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Request>) {
        let mut frames = interval(FRAME_TIME);
        frames.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut ui = interval(UI_TICK);
        ui.set_missed_tick_behavior(MissedTickBehavior::Skip);
        self.publish();

        loop {
            tokio::select! {
                command = commands.recv() => {
                    match command {
                        Some(Request::Command(command)) => {
                            if !self.command(command) { break; }
                        }
                        Some(Request::Capture { connection, capture, session, settings, with_audio }) => {
                            if self.state.connection.as_ref() == Some(&connection)
                                && let Some(call) = &mut self.active
                            {
                                call.media.publisher.start(capture, session, settings, with_audio, Instant::now());
                            }
                        }
                        None => break,
                    }
                    self.publish();
                }
                result = async {
                    match &mut self.joining {
                        Some(join) => timeout_at(join.deadline, &mut join.result)
                            .await
                            .map_err(|_| VoiceJoinError::TimedOut)?
                            .unwrap_or(Err(VoiceJoinError::Connection)),
                        None => pending().await,
                    }
                } => {
                    if !self.finish_join(result) { break; }
                    self.publish();
                }
                event = async {
                    match &mut self.active {
                        Some(call) => call.media.events.recv().await,
                        None => pending().await,
                    }
                } => self.event(event),
                () = self.audio.status_changed() => {
                    self.sync_mute();
                    self.publish();
                }
                _ = frames.tick(), if self.active.is_some() || self.mic_test || self.chime.is_some() || self.output_tail.is_some() => self.frame(Instant::now()),
                _ = ui.tick(), if self.active.is_some() || self.mic_test => self.publish(),
            }
        }

        self.leave(false);
        self.mic_test = false;
        self.configure_devices();
        self.publish();
    }

    fn command(&mut self, command: VoiceCommand) -> bool {
        let accepting_capture =
            |call: &Call, settings: &VoiceSettings| !call.policy.muted(settings.push_to_talk);
        let was_open = self
            .active
            .as_ref()
            .is_some_and(|call| accepting_capture(call, &self.settings));
        match command {
            VoiceCommand::Join(room) => self.join(room),
            VoiceCommand::Leave => self.leave(true),
            VoiceCommand::SetMuted(muted) => {
                if let Some(call) = &mut self.active {
                    call.policy.set_muted(muted, self.settings.push_to_talk);
                }
            }
            VoiceCommand::SetDeafened(deafened) => {
                if let Some(call) = &mut self.active {
                    call.policy.set_deafened(deafened);
                    if deafened {
                        self.audio.reset_output();
                        if self.chime.as_ref().is_some_and(|chime| !chime.is_test()) {
                            self.chime = None;
                        }
                    }
                }
            }
            VoiceCommand::Hold(source, held) => {
                let permitted = self.settings.push_to_talk
                    && !self.state.reconnecting
                    && self.capture_available();
                if let Some(call) = &mut self.active {
                    call.policy.hold(source, held, permitted);
                }
            }
            VoiceCommand::ReleaseLocalHolds => {
                if let Some(call) = &mut self.active {
                    call.policy.release_local();
                }
            }
            VoiceCommand::ReleaseHolds => {
                if let Some(call) = &mut self.active {
                    call.policy.release_all();
                }
            }
            VoiceCommand::Settings(settings) => self.update_settings(settings),
            VoiceCommand::RefreshDevices => self.audio.refresh(),
            VoiceCommand::MicTest(test) => {
                let testing = test && self.active.is_none();
                if self.mic_test != testing {
                    self.audio.reset_input();
                    self.processor = None;
                    self.mic_level = 0.0;
                    self.mic_test = testing;
                }
            }
            VoiceCommand::SpeakerTest => {
                self.speaker_test_failed = false;
                self.start_chime(Cue::Test);
            }
            VoiceCommand::Gain(connection, value) => {
                self.state.gains.insert(connection, gain_percent(value));
            }
            VoiceCommand::WatchShare {
                call,
                expected,
                target,
            } => {
                self.update_share_watch(&call, expected.as_ref(), Some(target));
            }
            VoiceCommand::DismissShare { call, expected } => {
                self.update_share_watch(&call, expected.as_ref(), None);
            }
            VoiceCommand::ShareVideoVisible(visible) => {
                self.share_video_visible = visible;
                if !visible {
                    self.share_frames.clear();
                }
                self.reconcile_shares(true);
            }
            VoiceCommand::ShareGain(percent) => {
                let gain = gain_percent(percent);
                if self.state.share_gain != gain {
                    self.state.share_gain = gain;
                    self.audio.reset_output();
                }
            }
            VoiceCommand::StopSharing => {
                if let Some(call) = &mut self.active {
                    call.media.publisher.stop();
                }
                self.reconcile_shares(true);
            }
            VoiceCommand::Shutdown => return false,
        }
        if !was_open
            && self
                .active
                .as_ref()
                .is_some_and(|call| accepting_capture(call, &self.settings))
        {
            self.audio.reset_input();
        }
        self.configure_devices();
        self.sync_mute();
        true
    }

    fn update_settings(&mut self, settings: VoiceSettings) {
        let settings = settings.validated();
        let input_changed = settings.mic_id != self.settings.mic_id;
        if let Some(call) = &mut self.active {
            if settings.push_to_talk != self.settings.push_to_talk {
                call.policy.set_muted(true, settings.push_to_talk);
            }
            if input_changed {
                call.policy.release_all();
            }
            if settings.away_mute != self.settings.away_mute
                || settings.away_minutes != self.settings.away_minutes
            {
                call.policy.reset_away();
            }
        }
        if input_changed {
            self.last_capture = None;
            self.mic_level = 0.0;
        }
        if input_changed || self.settings.processing() != settings.processing() {
            self.processor = None;
        }
        if self.settings.chimes
            && !settings.chimes
            && self.chime.as_ref().is_some_and(|chime| !chime.is_test())
        {
            self.audio.reset_output();
            self.chime = None;
        }
        if settings.speaker_id != self.settings.speaker_id {
            self.speaker_test_failed = false;
        }
        self.settings = settings;
    }

    fn join(&mut self, room: RoomId) {
        if self.state.joining.as_ref() == Some(&room) {
            return;
        }
        self.joining = None;
        self.state.joining = None;
        if self.state.room.as_ref() == Some(&room) {
            return;
        }

        self.state.joining = Some(room.clone());
        let (send, result) = oneshot::channel();
        tokio::spawn(admit(self.api.clone(), room.clone(), send));
        self.joining = Some(Joining {
            room,
            result,
            deadline: Instant::now() + JOIN_TIMEOUT,
        });
    }

    fn finish_join(&mut self, result: Result<Admitted, VoiceJoinError>) -> bool {
        let attempt = self.joining.take().expect("completed voice attempt");
        self.state.joining = None;
        let Admitted {
            room,
            events,
            connection,
            accepted,
        } = match result {
            Ok(admitted) => admitted,
            Err(error) => {
                let unauthorized =
                    matches!(&error, VoiceJoinError::Admission(error) if error.is_unauthorized());
                let _ = self.notices.send(VoiceNotice::JoinFailed {
                    room: attempt.room,
                    error,
                });
                return !unauthorized;
            }
        };
        if accepted.send(()).is_err() {
            return true;
        }

        // The new guarded room has connected before the old microphone is stopped.
        // No new track can be published until this actor has made the new room active.
        let policy = if let Some(call) = self.active.take() {
            let policy = call.policy.for_switch();
            call.media.close();
            policy
        } else {
            MicPolicy::new(self.settings.join_muted)
        };
        self.audio.reset_input();
        self.audio.reset_output();
        self.share_frames.clear();
        self.processor = None;
        self.last_capture = None;
        self.mic_test = false;
        self.state.room = Some(attempt.room);
        self.state.connection = Some(connection);
        self.state.reconnecting = false;
        self.active = Some(Call {
            media: MediaRoom::new(room, events),
            policy,
        });
        self.chime_if_enabled(Cue::Join);
        self.configure_devices();
        true
    }

    fn leave(&mut self, play_cue: bool) {
        self.joining = None;
        self.state.joining = None;
        self.detach_call(play_cue);
        if !play_cue {
            self.chime = None;
            self.output_tail = None;
        }
    }

    fn detach_call(&mut self, play_cue: bool) {
        if let Some(call) = self.active.take() {
            self.audio.reset_input();
            self.audio.reset_output();
            self.processor = None;
            if play_cue && self.settings.chimes && !call.policy.deafened {
                self.start_chime(Cue::Leave);
            }
            call.media.close();
        }
        self.share_frames.clear();
        self.state.room = None;
        self.state.connection = None;
        self.state.reconnecting = false;
        self.last_capture = None;
        self.mic_level = 0.0;
    }

    fn event(&mut self, event: Option<RoomEvent>) {
        match event {
            Some(RoomEvent::Reconnecting) => {
                self.state.reconnecting = true;
                if let Some(call) = &mut self.active {
                    call.policy.release_all();
                    call.media.watcher.suspend(&self.share_frames);
                }
                self.audio.reset_output();
                self.sync_mute();
                self.publish();
            }
            Some(RoomEvent::Reconnected) => {
                self.audio.reset_input();
                if let Some(call) = &mut self.active {
                    call.media.resume();
                }
                self.state.reconnecting = false;
                self.reconcile_shares(true);
                self.sync_mute();
                self.publish();
            }
            Some(RoomEvent::Disconnected { .. }) | None => {
                self.detach_call(true);
                let _ = self.notices.send(VoiceNotice::Disconnected);
                self.configure_devices();
                self.publish();
            }
            Some(event) => {
                if !self.state.reconnecting {
                    match event {
                        RoomEvent::ParticipantConnected(_) => self.chime_if_enabled(Cue::Join),
                        RoomEvent::ParticipantDisconnected(_) => self.chime_if_enabled(Cue::Leave),
                        _ => {}
                    }
                }
                let announce = !matches!(event, RoomEvent::Connected { .. });
                if let Some(call) = &mut self.active {
                    let reconcile = call.media.watcher.event(&event);
                    call.media.event(event, self.state.reconnecting);
                    if reconcile {
                        self.reconcile_shares(announce);
                        self.publish();
                    }
                }
            }
        }
    }

    fn update_share_watch(
        &mut self,
        call: &ConnectionId,
        expected: Option<&ConnectionId>,
        target: Option<ConnectionId>,
    ) {
        if self.state.connection.as_ref() != Some(call) {
            return;
        }
        if let Some(call) = &mut self.active
            && call.media.watcher.change_target(expected, target)
        {
            self.audio.reset_output();
            self.share_frames.clear();
            self.reconcile_shares(true);
        }
    }

    fn reconcile_shares(&mut self, announce: bool) {
        let Some(call) = &mut self.active else { return };
        let previous = call.media.watcher.target().cloned();
        let local = self
            .state
            .connection
            .clone()
            .filter(|_| call.media.publisher.sharing());
        if self.state.reconnecting {
            call.media.watcher.update_local(local);
            if previous.as_ref() != call.media.watcher.target() {
                self.share_frames.clear();
            }
            return;
        }
        let started = call.media.watcher.reconcile(
            &call.media.room,
            &self.share_frames,
            local,
            self.share_video_visible,
        );
        if previous.as_ref() != call.media.watcher.target() {
            self.audio.reset_output();
        }
        if started && announce {
            self.chime_if_enabled(Cue::Share);
        }
    }

    fn chime_if_enabled(&mut self, cue: Cue) {
        if self.settings.chimes
            && !self
                .active
                .as_ref()
                .is_some_and(|call| call.policy.deafened)
            && !self.chime.as_ref().is_some_and(Chime::is_test)
        {
            self.start_chime(cue);
        }
    }

    fn start_chime(&mut self, cue: Cue) {
        self.chime = Some(Chime::new(cue));
        self.output_tail = None;
        self.configure_devices();
    }

    fn configure_devices(&mut self) {
        let input = self.active.is_some() || self.mic_test;
        let output = self.active.is_some() || self.chime.is_some() || self.output_tail.is_some();
        self.audio.configure(DeviceConfig {
            input: input.then(|| self.settings.mic_id.clone()),
            output: output.then(|| self.settings.speaker_id.clone()),
        });
    }

    fn capture_available(&self) -> bool {
        self.last_capture
            .is_some_and(|last| last.elapsed() < Duration::from_millis(120))
            && self.audio.status().input_open
    }

    fn sync_mute(&mut self) {
        let capture = self.capture_available();
        if let Some(call) = &mut self.active {
            if !capture {
                call.policy.release_all();
            }
            let muted = !capture
                || self.state.reconnecting
                || call.policy.muted(self.settings.push_to_talk);
            call.media.set_muted(muted);
        }
    }

    fn frame(&mut self, now: Instant) {
        let was_playing = self.chime.is_some();
        let was_draining = self.output_tail.is_some();
        let devices = self.audio.status();
        let capture = if devices.input_open {
            self.audio.capture()
        } else {
            None
        };
        if capture.is_some() {
            self.last_capture = Some(now);
        }
        let mut processed = capture;
        if self.active.is_some() || self.mic_test {
            let processor = self
                .processor
                .get_or_insert_with(|| Processor::new(&self.settings));
            while let Some(mut rendered) = self.audio.reference() {
                processor.reverse(&mut rendered);
            }
            if let Some(block) = &mut processed
                && !processor.capture(block, self.audio.stream_delay_ms())
            {
                processed = None;
            }
        }
        let metered = if self.mic_test { &processed } else { &capture };
        self.mic_level = smooth(self.mic_level, metered.as_ref().map_or(0.0, pcm_loudness));
        let capture_available = self.capture_available();
        if let Some(call) = &mut self.active {
            if !self.state.reconnecting {
                call.media.service_mic(capture_available, now);
                call.media.service_attributes(call.policy.deafened, now);
            }
            if !capture_available || !call.media.microphone_ready() {
                call.policy.release_all();
            }
            let observable =
                !self.state.reconnecting && capture_available && call.media.microphone_ready();
            if !observable || capture.is_some() {
                let measured = capture.as_ref().filter(|_| observable).map(pcm_loudness);
                if let Some(minutes) = call.policy.observe(&self.settings, now, measured) {
                    let _ = self.notices.send(VoiceNotice::AwayMuted { minutes });
                }
            }
            let muted = !capture_available
                || self.state.reconnecting
                || call.policy.muted(self.settings.push_to_talk);
            call.media.set_muted(muted);
            if !muted {
                call.media.capture(processed.as_ref().unwrap_or(&SILENCE));
            }
        }
        self.share_frame(now);

        if devices.output_unavailable {
            self.speaker_test_failed |= self.chime.as_ref().is_some_and(Chime::is_test);
            self.chime = None;
            self.output_tail = None;
            if let Some(call) = &mut self.active {
                call.media.watcher.mix(&mut Mix::default(), true, 0);
            }
        } else if devices.output_open {
            self.speaker_test_failed = false;
            let mut mix = Mix::default();
            if let Some(call) = &mut self.active {
                let silent = call.policy.deafened || self.state.reconnecting;
                call.media.mix(&mut mix, silent, |connection| {
                    self.state.gains.get(connection).copied().unwrap_or(100)
                });
                call.media
                    .watcher
                    .mix(&mut mix, silent, self.state.share_gain);
            }
            if let Some(chime) = &mut self.chime {
                if let Some(block) = chime.next() {
                    mix.add(&block, 100);
                } else {
                    self.chime = None;
                    // Keep the idle speaker open until the last queued samples play.
                    self.output_tail = Some(now + Duration::from_millis(180));
                }
            }
            self.audio.output(mix.finish());
        } else if let Some(call) = &mut self.active {
            call.media.mix(&mut Mix::default(), true, |_| 100);
            call.media.watcher.mix(&mut Mix::default(), true, 0);
        }

        if self.output_tail.is_some_and(|end| now >= end) {
            self.output_tail = None;
        }
        self.configure_devices();
        if (was_playing && self.chime.is_none()) || (was_draining && self.output_tail.is_none()) {
            self.publish();
        }
    }

    fn share_frame(&mut self, now: Instant) {
        let Some(call) = &mut self.active else { return };
        let was_sharing = call.media.publisher.sharing();
        let was_publishing = call.media.publisher.publishing();
        let connected = !self.state.reconnecting
            && call.media.room.connection_state() == ConnectionState::Connected;
        if let Some(notice) = call
            .media
            .publisher
            .service(&call.media.room, connected, now)
        {
            let _ = self.notices.send(notice);
        }
        if was_sharing != call.media.publisher.sharing()
            || was_publishing != call.media.publisher.publishing()
        {
            self.reconcile_shares(true);
            self.publish();
        }
        if let Some(call) = &mut self.active {
            call.media.watcher.frame(
                &self.share_frames,
                call.media.publisher.preview(),
                self.share_video_visible,
            );
        }
    }

    fn publish(&mut self) {
        let status = self.audio.status();
        self.state.devices.clone_from(status.devices.as_ref());
        self.state.input_unavailable = status.input_unavailable;
        self.state.output_unavailable = status.output_unavailable || self.speaker_test_failed;
        self.state.mic_level = self.mic_level;
        self.state.mic_test_active = self.mic_test;
        self.state.speaker_test_active = self.chime.as_ref().is_some_and(Chime::is_test);

        if let (Some(call), Some(connection)) = (&self.active, &self.state.connection) {
            self.state.deafened = call.policy.deafened;
            self.state.watched_share = call.media.watcher.target().cloned();
            self.state.sharing = call.media.publisher.sharing();
            self.state.publishing_share = call.media.publisher.publishing();
            self.state.listen_only = status.input_unavailable || call.media.microphone_failed();
            self.state.muted = self.state.reconnecting
                || !self.capture_available()
                || !call.media.microphone_ready()
                || call.policy.muted(self.settings.push_to_talk);
            self.state.participants = call.media.participants(
                connection,
                self.state.muted,
                self.state.deafened,
                self.state.mic_level,
            );
        } else {
            self.state.muted = true;
            self.state.deafened = false;
            self.state.listen_only = false;
            self.state.watched_share = None;
            self.state.sharing = false;
            self.state.publishing_share = false;
            self.state.participants.clear();
        }
        self.updates.send_if_modified(|previous| {
            if previous == &self.state {
                return false;
            }
            previous.clone_from(&self.state);
            true
        });
    }
}

async fn admit(
    api: ApiClient,
    room: RoomId,
    mut result: oneshot::Sender<Result<Admitted, VoiceJoinError>>,
) {
    let grant = tokio::select! {
        biased;
        _ = result.closed() => return,
        grant = timeout(JOIN_TIMEOUT, request_grant(api, room)) => {
            grant.unwrap_or(Err(VoiceJoinError::TimedOut))
        }
    };
    let grant = match grant {
        Ok(grant) => grant,
        Err(error) => {
            let _ = result.send(Err(error));
            return;
        }
    };
    if result.is_closed() {
        return;
    }

    // Once native signaling starts, let the SDK finish or run its timeout cleanup.
    // The actor can stop waiting without dropping that connection future.
    let (room, events) = match connect(&grant).await {
        Ok(room) => room,
        Err(error) => {
            let _ = result.send(Err(error));
            return;
        }
    };
    let room = Arc::new(room);
    let (accepted, confirmation) = oneshot::channel();
    let _ = result.send(Ok(Admitted {
        room: room.clone(),
        events,
        connection: grant.grant_id,
        accepted,
    }));
    // Receiving the result and relinquishing cleanup are separate: cancellation
    // can also drop a result that the task has already sent.
    if confirmation.await.is_err() {
        let _ = room.close().await;
    }
}

async fn request_grant(api: ApiClient, room: RoomId) -> Result<VoiceCredentials, VoiceJoinError> {
    let request = api
        .request(Method::POST, &["api", "rooms", room.as_str(), "voice"])
        .empty_json();
    let grant: VoiceCredentials = api.json(request).await?;
    if !guarded_origin(&api, &grant.url) {
        return Err(VoiceJoinError::Connection);
    }
    Ok(grant)
}

async fn connect(
    grant: &VoiceCredentials,
) -> Result<(Room, mpsc::UnboundedReceiver<RoomEvent>), VoiceJoinError> {
    transport::register();
    let _runtime = media::runtime();
    let mut options = RoomOptions::default();
    options.auto_subscribe = false;
    options.join_retries = 0;
    options.connect_timeout = Duration::from_secs(10);
    let (room, events) = Room::connect(&grant.url, grant.token.expose_secret(), options)
        .await
        .map_err(|_| VoiceJoinError::Connection)?;
    if room.local_participant().identity().as_str() != grant.grant_id.as_str() {
        let _ = room.close().await;
        return Err(VoiceJoinError::Connection);
    }
    Ok((room, events))
}

fn guarded_origin(api: &ApiClient, value: &str) -> bool {
    let Ok(mut target) = Url::parse(value) else {
        return false;
    };
    let scheme = match target.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => return false,
    };
    target.set_scheme(scheme).is_ok() && api.origin().contains_url(&target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Origin, audio::AudioDevice, model::SessionGeneration};

    fn test_actor(audio: AudioIo) -> (Actor, watch::Receiver<VoiceSnapshot>) {
        let origin = Origin::parse("http://localhost:8080").unwrap();
        let state = VoiceSnapshot::new(
            SessionScope {
                origin: origin.clone(),
                generation: SessionGeneration(1),
            },
            BTreeMap::new(),
        );
        let (updates, snapshots) = watch::channel(state.clone());
        let (notices, _) = broadcast::channel(1);
        let actor = Actor::new(
            ApiClient::new(origin).unwrap(),
            VoiceSettings::default(),
            state,
            updates,
            notices,
            audio,
        );
        (actor, snapshots)
    }

    #[tokio::test]
    async fn actor_publishes_unavailable_on_failed_worker_start_and_accepts_commands() {
        let (actor, mut snapshots) = test_actor(AudioIo::test_failed_worker_start());
        let (commands, receiver) = mpsc::unbounded_channel();
        let task = tokio::spawn(actor.run(receiver));

        timeout(Duration::from_secs(2), async {
            snapshots.changed().await.unwrap();
            {
                let initial = snapshots.borrow_and_update();
                assert!(initial.input_unavailable && initial.output_unavailable);
                assert!(!initial.mic_test_active);
            }

            commands
                .send(Request::Command(VoiceCommand::MicTest(true)))
                .ok()
                .unwrap();
            snapshots
                .wait_for(|state| state.mic_test_active && state.input_unavailable)
                .await
                .unwrap();
            commands
                .send(Request::Command(VoiceCommand::Shutdown))
                .ok()
                .unwrap();
            task.await.unwrap();
            assert!(!snapshots.borrow().mic_test_active);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn idle_actor_reads_initial_devices_and_shuts_down_after_worker_closure() {
        let (audio, _requests, status) = AudioIo::test_channel();
        let (actor, mut snapshots) = test_actor(audio);
        let (commands, receiver) = mpsc::unbounded_channel();
        status.send_modify(|(_, report)| {
            Arc::make_mut(&mut report.devices).input.push(AudioDevice {
                id: "mic".into(),
                name: "Microphone".into(),
            });
        });
        let task = tokio::spawn(actor.run(receiver));
        timeout(Duration::from_secs(2), async {
            snapshots
                .wait_for(|state| state.devices.input.len() == 1)
                .await
                .unwrap();
            drop(status);
            snapshots
                .wait_for(|state| state.input_unavailable && state.devices.input.len() == 1)
                .await
                .unwrap();
            commands
                .send(Request::Command(VoiceCommand::MicTest(true)))
                .ok()
                .unwrap();
            snapshots
                .wait_for(|state| state.mic_test_active)
                .await
                .unwrap();
            drop(commands);
            task.await.unwrap();
            assert!(!snapshots.borrow().mic_test_active);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn actor_releases_capture_from_an_obsolete_connection() {
        struct NativeGuard(Option<oneshot::Sender<()>>);

        impl Drop for NativeGuard {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }

        let (actor, mut snapshots) = test_actor(AudioIo::test_failed_worker_start());
        let (commands, receiver) = mpsc::unbounded_channel();
        let task = tokio::spawn(actor.run(receiver));
        let (released, done) = oneshot::channel();
        let (_, capture) = screen_capture();
        commands
            .send(Request::Capture {
                connection: ConnectionId::from("obsolete"),
                capture,
                session: Box::new(NativeGuard(Some(released))),
                settings: SharePublishSettings::default(),
                with_audio: true,
            })
            .ok()
            .unwrap();
        timeout(Duration::from_secs(2), done)
            .await
            .unwrap()
            .unwrap();
        assert!(!snapshots.borrow_and_update().publishing_share);
        drop(commands);
        task.await.unwrap();
    }

    #[test]
    fn speaker_test_publishes_completion_and_failure_and_releases_its_route() {
        let (audio, requests, status) = AudioIo::test_channel();
        let (mut actor, snapshots) = test_actor(audio);
        assert!(actor.command(VoiceCommand::SpeakerTest));
        actor.publish();
        assert!(snapshots.borrow().speaker_test_active);
        requests.try_recv().unwrap();
        status.send_modify(|(generation, report)| {
            *generation = 1;
            report.output_open = true;
        });

        let now = Instant::now();
        for index in 0..100 {
            actor.frame(now + FRAME_TIME * index);
            if actor.chime.is_none() {
                break;
            }
        }
        assert!(!snapshots.borrow().speaker_test_active);
        assert!(!snapshots.borrow().output_unavailable);
        let tail = actor.output_tail.unwrap();
        assert!(requests.try_recv().is_err());
        actor.frame(tail);
        assert!(actor.output_tail.is_none());
        requests.try_recv().unwrap();

        assert!(actor.command(VoiceCommand::SpeakerTest));
        actor.publish();
        assert!(snapshots.borrow().speaker_test_active);
        requests.try_recv().unwrap();
        status.send_modify(|(generation, report)| {
            *generation = 3;
            report.output_open = false;
            report.output_unavailable = true;
        });
        actor.frame(tail + FRAME_TIME);
        assert!(!snapshots.borrow().speaker_test_active);
        assert!(snapshots.borrow().output_unavailable);
        assert!(actor.output_tail.is_none());
        requests.try_recv().unwrap();
    }

    #[test]
    fn grant_uses_the_session_origin_and_transport_security() {
        let api = ApiClient::new(Origin::parse("https://falky.example:8443").unwrap()).unwrap();
        assert!(guarded_origin(&api, "wss://falky.example:8443"));
        for url in [
            "wss://falky.example",
            "wss://voice.falky.example:8443",
            "wss://user@falky.example:8443",
            "ws://falky.example:8443",
            "https://falky.example:8443",
        ] {
            assert!(!guarded_origin(&api, url));
        }
        let local = ApiClient::new(Origin::parse("http://localhost:8080").unwrap()).unwrap();
        assert!(guarded_origin(&local, "ws://localhost:8080"));
        assert!(!guarded_origin(&local, "ws://127.0.0.1:8080"));
    }
}
