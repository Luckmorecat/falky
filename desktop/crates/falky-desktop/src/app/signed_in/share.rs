use std::{
    fmt,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use falky_core::{
    model::{ConnectionId, RoomId, SessionScope},
    voice::{
        self, ScreenCapture, ShareCodec, ShareFocus, ShareFrame, SharePublishSettings, Voice,
        VoiceCommand, VoiceSnapshot,
    },
};
use iced::{Task, task::Handle, window};

use crate::{
    locale::Key,
    platform::capture::{self, CaptureError, CaptureOptions, CaptureResult},
    settings, shell,
};

use super::super::Message;

#[derive(Clone, Debug, Hash)]
pub(in crate::app) struct ViewerScope {
    pub call: ConnectionId,
    pub selected: Option<ConnectionId>,
}

impl ViewerScope {
    pub fn matches(&self, call: Option<&ConnectionId>, selected: Option<&ConnectionId>) -> bool {
        call == Some(&self.call) && selected == self.selected.as_ref()
    }

    pub fn watch_command(self, action: &shell::ShareAction) -> Option<VoiceCommand> {
        let Self {
            call,
            selected: expected,
        } = self;
        match action {
            shell::ShareAction::Watch(target) => Some(VoiceCommand::WatchShare {
                call,
                expected,
                target: target.clone(),
            }),
            shell::ShareAction::StopWatching => Some(VoiceCommand::DismissShare { call, expected }),
            _ => None,
        }
    }
}

pub(super) fn shell_message(
    scope: SessionScope,
    viewer: Option<&ViewerScope>,
    action: shell::Action,
) -> Message {
    match action {
        shell::Action::Share(
            action @ (shell::ShareAction::Watch(_)
            | shell::ShareAction::StopWatching
            | shell::ShareAction::ToggleFullscreen
            | shell::ShareAction::PointerMoved),
        ) => Message::ShareViewer(scope, viewer.cloned(), action),
        action => Message::Shell(scope, action),
    }
}

#[derive(Default)]
pub(super) struct Share {
    pub watched: Option<ConnectionId>,
    pub sharing: bool,
    publishing: bool,
    requested: Option<bool>,
    video_visible: Option<bool>,
    generation: u64,
    picker: Option<Picker>,
}

struct Picker {
    generation: u64,
    connection: ConnectionId,
    _cancelled: CancelOnDrop,
    settings: SharePublishSettings,
    with_audio: bool,
    capture: ScreenCapture,
    _guard: Handle,
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
pub(in crate::app) struct CaptureReady {
    generation: u64,
    result: Arc<Mutex<Option<CaptureResult>>>,
}

impl fmt::Debug for CaptureReady {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CaptureReady")
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl CaptureReady {
    fn new(generation: u64, result: CaptureResult) -> Self {
        Self {
            generation,
            result: Arc::new(Mutex::new(Some(result))),
        }
    }

    fn take(self) -> Option<CaptureResult> {
        self.result.lock().ok()?.take()
    }
}

impl Share {
    pub fn snapshot(&mut self, snapshot: &VoiceSnapshot, call_changed: bool) {
        if call_changed {
            self.cancel_picker();
            self.requested = None;
        }
        self.watched.clone_from(&snapshot.watched_share);
        self.sharing = snapshot.sharing;
        self.publishing = snapshot.publishing_share;
        if self.requested == Some(self.sharing || self.publishing) {
            self.requested = None;
        }
    }

    pub fn status(&self, in_voice: bool) -> shell::ShareCaptureStatus {
        use shell::ShareCaptureStatus::*;
        if !in_voice {
            Hidden
        } else if self.requested == Some(false) {
            Stopping
        } else if self.sharing {
            Sharing
        } else if self.picker.is_some() || self.publishing || self.requested == Some(true) {
            Starting
        } else {
            Idle
        }
    }

    pub fn can_stop(&self) -> bool {
        (self.sharing || self.publishing || self.requested == Some(true))
            && self.requested != Some(false)
    }

    pub fn update_video_visibility(
        &mut self,
        window_visible: bool,
        viewed: Option<&RoomId>,
        connected: Option<&RoomId>,
    ) -> Option<VoiceCommand> {
        let visible = window_visible && viewing_call(viewed, connected);
        let previous = self.video_visible.replace(visible);
        (previous != Some(visible)).then_some(VoiceCommand::ShareVideoVisible(visible))
    }

    pub fn video_visible(&self) -> bool {
        self.video_visible == Some(true)
    }

    pub fn cancel_picker(&mut self) {
        self.picker = None;
    }

    pub fn failed(&mut self) {
        self.requested = None;
    }

    pub fn start(
        &mut self,
        window: window::Id,
        scope: SessionScope,
        connection: ConnectionId,
        preferences: settings::ShareSettings,
    ) -> Task<Message> {
        let availability = capture::available();
        let settings = publish_settings(preferences);
        let with_audio = preferences.with_sound && availability.audio;
        let (sink, capture) = voice::screen_capture();
        self.generation += 1;
        let generation = self.generation;
        let cancelled = Arc::new(AtomicBool::new(false));
        let pending = Arc::clone(&cancelled);
        let options = CaptureOptions {
            max_width: settings.width,
            max_height: settings.height,
            fps: settings.fps,
            with_audio,
        };
        let (task, guard) = window::run(window, move |window| {
            if pending.load(Ordering::Acquire) || !availability.video {
                None
            } else {
                Some(capture::begin(window, options, sink))
            }
        })
        .then(move |start| {
            let scope = scope.clone();
            Task::perform(
                async move {
                    match start {
                        Some(start) => start.await,
                        None => Err(CaptureError::Unavailable),
                    }
                },
                move |result| Message::CaptureReady(scope, CaptureReady::new(generation, result)),
            )
        })
        .abortable();
        self.picker = Some(Picker {
            generation,
            connection,
            _cancelled: CancelOnDrop(cancelled),
            settings,
            with_audio,
            capture,
            _guard: guard.abort_on_drop(),
        });
        task
    }

    fn take_picker(
        &mut self,
        connection: Option<&ConnectionId>,
        generation: u64,
    ) -> Option<Picker> {
        let picker = self.picker.as_ref()?;
        if picker.generation != generation || Some(&picker.connection) != connection {
            return None;
        }
        self.picker.take()
    }

    pub fn finish(
        &mut self,
        voice: &Voice,
        connection: Option<&ConnectionId>,
        ready: CaptureReady,
    ) -> Option<Key> {
        let picker = self.take_picker(connection, ready.generation)?;
        match ready.take()? {
            Ok(Some(native)) => {
                // The actor repeats the connection check at admission.
                if voice.start_share(
                    picker.connection,
                    picker.capture,
                    native,
                    picker.settings,
                    picker.with_audio,
                ) {
                    self.requested = Some(true);
                }
                None
            }
            Ok(None) => None,
            Err(CaptureError::Unavailable) => Some(Key::ShareCaptureUnavailable),
            Err(CaptureError::PermissionDenied) => Some(Key::SharePermissionDenied),
            Err(CaptureError::Failed) => Some(Key::ShareCaptureFailed),
        }
    }

    pub fn stop(&mut self, voice: &Voice) {
        self.cancel_picker();
        if self.can_stop() && voice.command(VoiceCommand::StopSharing) {
            self.requested = Some(false);
        }
    }
}

pub(super) fn viewing_call(viewed: Option<&RoomId>, connected: Option<&RoomId>) -> bool {
    connected.is_some() && viewed == connected
}

pub(super) fn settings_status(sharing: bool) -> settings::ShareStatus<'static> {
    use settings::ShareAudioAvailability::*;
    static CODECS: OnceLock<Vec<settings::ShareCodec>> = OnceLock::new();
    let availability = capture::available();
    let audio = match (std::env::consts::OS, availability.audio) {
        ("windows", true) => WindowsSystemAudio,
        (_, true) => Available,
        ("linux", false) => LinuxUnavailable,
        ("macos", false) => MacosUnavailable,
        ("windows", false) => WindowsUnavailable,
        (_, false) => Unavailable,
    };
    settings::ShareStatus {
        audio,
        capture_available: availability.video,
        sharing,
        codecs: CODECS.get_or_init(|| {
            voice::supported_share_codecs()
                .into_iter()
                .map(|codec| match codec {
                    ShareCodec::Vp8 => settings::ShareCodec::Vp8,
                    ShareCodec::H264 => settings::ShareCodec::H264,
                    ShareCodec::Vp9 => settings::ShareCodec::Vp9,
                    ShareCodec::Av1 => settings::ShareCodec::Av1,
                    ShareCodec::H265 => settings::ShareCodec::H265,
                })
                .collect()
        }),
    }
}

fn publish_settings(preferences: settings::ShareSettings) -> SharePublishSettings {
    let (width, height) = preferences.dimensions();
    SharePublishSettings {
        width,
        height,
        fps: preferences.fps.value(),
        focus: match preferences.focus {
            settings::ShareFocus::Motion => ShareFocus::Motion,
            settings::ShareFocus::Detail => ShareFocus::Detail,
        },
        codec: match preferences.codec {
            settings::ShareCodec::Vp8 => ShareCodec::Vp8,
            settings::ShareCodec::H264 => ShareCodec::H264,
            settings::ShareCodec::Vp9 => ShareCodec::Vp9,
            settings::ShareCodec::Av1 => ShareCodec::Av1,
            settings::ShareCodec::H265 => ShareCodec::H265,
        },
        bitrate_bps: (preferences.bitrate_mbps > 0).then(|| preferences.bitrate_bps()),
    }
}

impl shell::PlanarFrame for ShareFrame {
    fn dimensions(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    fn planes(&self) -> [shell::Plane<'_>; 3] {
        let (y, u, v) = self.planes();
        [
            shell::Plane {
                bytes: y,
                stride: self.stride_y,
            },
            shell::Plane {
                bytes: u,
                stride: self.stride_u,
            },
            shell::Plane {
                bytes: v,
                stride: self.stride_v,
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_current_connection_and_request_can_finish_the_picker() {
        let connection = ConnectionId::from("second");
        let cancelled = Arc::new(AtomicBool::new(false));
        let (_, capture) = voice::screen_capture();
        let (_, guard) = Task::<()>::none().abortable();
        let mut share = Share {
            picker: Some(Picker {
                generation: 2,
                connection: connection.clone(),
                _cancelled: CancelOnDrop(Arc::clone(&cancelled)),
                settings: SharePublishSettings::default(),
                with_audio: false,
                capture,
                _guard: guard.abort_on_drop(),
            }),
            ..Share::default()
        };

        assert!(share.take_picker(Some(&connection), 1).is_none());
        assert!(
            share
                .take_picker(Some(&ConnectionId::from("first")), 2)
                .is_none()
        );
        assert_eq!(share.status(true), shell::ShareCaptureStatus::Starting);
        assert!(!cancelled.load(Ordering::Acquire));
        assert!(share.take_picker(Some(&connection), 2).is_some());
        assert_eq!(share.status(true), shell::ShareCaptureStatus::Idle);
        assert!(cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn video_visibility_tracks_both_the_window_and_the_viewed_room() {
        let mut share = Share::default();
        let connected = RoomId::from("connected");
        let other = RoomId::from("other");

        for (window, viewed, voice, expected) in [
            (true, None, None, false),
            (true, Some(&connected), Some(&connected), true),
            (false, Some(&connected), Some(&connected), false),
            (true, Some(&connected), Some(&connected), true),
            (true, Some(&other), Some(&connected), false),
            (true, Some(&connected), Some(&connected), true),
        ] {
            assert!(matches!(
                share.update_video_visibility(window, viewed, voice),
                Some(VoiceCommand::ShareVideoVisible(visible)) if visible == expected
            ));
            assert_eq!(share.video_visible(), expected);
            assert!(
                share
                    .update_video_visibility(window, viewed, voice)
                    .is_none()
            );
        }
    }

    #[test]
    fn a_viewer_action_cannot_affect_a_new_call_or_selection() {
        let call = ConnectionId::from("call");
        let selected = ConnectionId::from("selected");
        let new_share = ConnectionId::from("replacement");
        let source = ViewerScope {
            call: call.clone(),
            selected: Some(selected.clone()),
        };
        assert!(source.matches(Some(&call), Some(&selected)));
        assert!(!source.matches(Some(&call), Some(&new_share)));
        assert!(!source.matches(Some(&call), None));
        assert!(!source.matches(Some(&ConnectionId::from("new call")), Some(&selected)));
    }

    #[test]
    fn capture_completion_can_transfer_the_native_session_only_once() {
        let ready = CaptureReady::new(1, Ok(Some(Box::new(()))));
        let duplicate = ready.clone();
        assert!(matches!(ready.take(), Some(Ok(Some(_)))));
        assert!(duplicate.take().is_none());
    }
}
