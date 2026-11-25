pub mod capture;
mod notifications;
mod shortcuts;
mod tray;

use crate::ui_contract::{
    GlobalPttStatus, Language, PttAction, PttSource, Shortcuts, TrayAction, VoiceAction,
    VoiceStatus,
};
use falky_core::model::{RoomId, SessionScope};
use futures_util::stream;
use iced::{Event, Subscription, Task, event, keyboard, window};
use keyboard::key::{Code, Physical};
use tokio::sync::mpsc;

pub struct Input<'a> {
    pub voice: &'a VoiceStatus,
    pub shortcuts: &'a Shortcuts,
    pub can_stop_sharing: bool,
    pub push_to_talk: bool,
    pub suppress_shortcuts: bool,
    pub language: Language,
}

impl Input<'_> {
    fn can_talk(&self) -> bool {
        self.push_to_talk
            && self.voice.room.is_some()
            && !self.voice.deafened
            && !self.voice.listen_only
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    Voice(VoiceAction),
    ConfirmVoiceLeave,
    StopSharing,
    ReleaseLocalHolds,
    Quit,
    NotificationOpened { scope: SessionScope, room: RoomId },
}

#[derive(Default)]
pub struct Update {
    pub task: Task<Message>,
    pub actions: Vec<Action>,
}

#[derive(Clone, Debug)]
pub struct Message(PlatformEvent);

#[derive(Clone, Debug)]
enum PlatformEvent {
    Opened(window::Id),
    Closed(window::Id),
    CloseRequested(window::Id),
    Focus(window::Id, bool),
    Resized(window::Id, iced::Size),
    Keyboard(window::Id, keyboard::Event, event::Status),
    Backend(shortcuts::Backend),
    TrayAvailability(bool),
    Tray(TrayAction),
    TrayToggleVisibility,
    Global(u64, shortcuts::GlobalEvent),
    ReleaseWindow(u64),
    ReleaseGlobal(u64),
    NotificationOpened { scope: SessionScope, room: RoomId },
}

type Events = mpsc::UnboundedSender<Message>;

pub struct Platform {
    window: Option<window::Id>,
    window_settings: window::Settings,
    hidden: bool,
    share_fullscreen: bool,
    focused: bool,
    shutting_down: bool,
    backend: Option<shortcuts::Backend>,
    events: Events,
    tray: tray::Tray,
    tray_available: bool,
    shortcuts: shortcuts::Global,
    window_hold: Option<Code>,
    window_press: u64,
    notifications: notifications::Notifications,
}

impl Platform {
    pub fn boot(mut settings: window::Settings) -> (Self, Task<Message>) {
        settings.exit_on_close_request = false;
        let (window, open) = window::open(settings.clone());
        let (events, receiver) = mpsc::unbounded_channel();
        let native = stream::unfold(receiver, |mut receiver| async {
            receiver.recv().await.map(|message| (message, receiver))
        });

        (
            Self {
                window: Some(window),
                window_settings: settings,
                hidden: false,
                share_fullscreen: false,
                focused: false,
                shutting_down: false,
                backend: None,
                events,
                tray: tray::Tray::default(),
                tray_available: false,
                shortcuts: shortcuts::Global::default(),
                window_hold: None,
                window_press: 0,
                notifications: notifications::Notifications::default(),
            },
            Task::batch([open.discard(), Task::stream(native)]),
        )
    }

    pub fn subscription(&self) -> Subscription<Message> {
        event::listen_with(|event, status, id| {
            let message = match event {
                Event::Window(window::Event::Opened { .. }) => PlatformEvent::Opened(id),
                Event::Window(window::Event::Closed) => PlatformEvent::Closed(id),
                Event::Window(window::Event::CloseRequested) => PlatformEvent::CloseRequested(id),
                Event::Window(window::Event::Resized(size)) => PlatformEvent::Resized(id, size),
                Event::Window(window::Event::Focused) => PlatformEvent::Focus(id, true),
                Event::Window(window::Event::Unfocused) => PlatformEvent::Focus(id, false),
                Event::Keyboard(event) => PlatformEvent::Keyboard(id, event, status),
                _ => return None,
            };
            Some(Message(message))
        })
    }

    pub fn update(&mut self, Message(event): Message, input: &Input<'_>) -> Update {
        let mut result = Update::default();
        if self.shutting_down {
            return result;
        }
        match event {
            PlatformEvent::Opened(id) if self.window == Some(id) => {
                self.tray.sync(tray::Snapshot::new(self.visible(), input));
                result.task = Task::batch([
                    self.tray.start(self.events.clone()),
                    if self.backend.is_none() {
                        window::run(id, shortcuts::Backend::detect)
                            .map(|backend| Message(PlatformEvent::Backend(backend)))
                    } else {
                        Task::none()
                    },
                ]);
            }
            PlatformEvent::Backend(backend) => {
                self.backend = Some(backend);
                result.task = self.shortcuts.start(backend, self.events.clone());
            }
            PlatformEvent::Closed(id) if self.window == Some(id) => {
                self.window = None;
                self.hidden = true;
                self.share_fullscreen = false;
                self.release_local(&mut result);
                if !self.tray_available {
                    result.actions.push(Action::Quit);
                }
            }
            PlatformEvent::CloseRequested(id) if self.window == Some(id) => {
                if input.voice.room.is_some() && self.tray_available {
                    result.task = self.hide(&mut result.actions);
                } else {
                    self.release_local(&mut result);
                    result.actions.push(Action::Quit);
                }
            }
            PlatformEvent::Resized(id, size) if self.window == Some(id) => {
                if !self.share_fullscreen && size.width > 0.0 && size.height > 0.0 {
                    self.window_settings.size = size;
                }
            }
            PlatformEvent::Focus(id, focused) if self.window == Some(id) => {
                if focused && self.visible() {
                    self.focused = true;
                    self.shortcuts.retry_after_accessibility();
                } else {
                    self.release_local(&mut result);
                }
            }
            PlatformEvent::Keyboard(id, event, status) if self.window == Some(id) => {
                self.keyboard(event, status, input, &mut result.actions);
            }
            PlatformEvent::TrayAvailability(available) => {
                self.tray_available = available;
                if !available && self.hidden {
                    result.task = self.show();
                }
            }
            PlatformEvent::TrayToggleVisibility => {
                result.task = if self.visible() {
                    self.hide(&mut result.actions)
                } else {
                    self.show()
                };
            }
            PlatformEvent::Tray(action) => match action {
                TrayAction::Show => result.task = self.show(),
                TrayAction::Hide => result.task = self.hide(&mut result.actions),
                TrayAction::ToggleMute if input.voice.room.is_some() => {
                    result.actions.push(Action::Voice(VoiceAction::ToggleMute));
                }
                TrayAction::ToggleDeafen if input.voice.room.is_some() => {
                    result
                        .actions
                        .push(Action::Voice(VoiceAction::ToggleDeafen));
                }
                TrayAction::StopSharing if input.can_stop_sharing => {
                    result.actions.push(Action::StopSharing);
                }
                TrayAction::LeaveVoice if input.voice.room.is_some() => {
                    result.actions.push(Action::Voice(VoiceAction::Leave));
                }
                TrayAction::Quit => {
                    self.release_local(&mut result);
                    result.actions.push(Action::Quit);
                }
                _ => {}
            },
            PlatformEvent::Global(generation, event) => {
                if let Some(pressed) = self.shortcuts.update(generation, event)
                    && (!pressed || input.can_talk())
                {
                    result.actions.push(hold(PttSource::Global, pressed));
                }
            }
            PlatformEvent::ReleaseWindow(press) if press == self.window_press => {
                result.actions.push(hold(PttSource::Window, false));
            }
            PlatformEvent::ReleaseGlobal(generation)
                if generation == self.shortcuts.generation() =>
            {
                result.actions.push(hold(PttSource::Global, false));
            }
            PlatformEvent::NotificationOpened { scope, room } => {
                result
                    .actions
                    .push(Action::NotificationOpened { scope, room });
            }
            _ => {}
        }
        result.task = Task::batch([result.task, self.sync(input)]);
        result
    }

    pub fn sync(&mut self, input: &Input<'_>) -> Task<Message> {
        if self.shutting_down {
            return Task::none();
        }
        self.tray.sync(tray::Snapshot::new(self.visible(), input));
        let global_release = self.shortcuts.configure(input.push_to_talk);
        let window_release = self.window_hold.is_some()
            && (!input.can_talk() || input.suppress_shortcuts || !self.focused());
        if window_release {
            self.window_hold = None;
        }
        Task::batch([
            if global_release {
                Task::done(Message(PlatformEvent::ReleaseGlobal(
                    self.shortcuts.generation(),
                )))
            } else {
                Task::none()
            },
            if window_release {
                Task::done(Message(PlatformEvent::ReleaseWindow(self.window_press)))
            } else {
                Task::none()
            },
        ])
    }

    pub fn window(&self) -> Option<window::Id> {
        self.window
    }

    pub fn visible(&self) -> bool {
        !self.hidden && self.window.is_some()
    }

    pub fn focused(&self) -> bool {
        self.visible() && self.focused
    }

    pub fn global_ptt_status(&self) -> GlobalPttStatus {
        self.shortcuts.status()
    }

    pub fn global_ptt_trigger(&self) -> Option<&str> {
        self.shortcuts.trigger()
    }

    pub fn open_accessibility_settings() {
        shortcuts::open_accessibility_settings();
    }

    pub fn set_share_fullscreen(&mut self, fullscreen: bool) -> Task<Message> {
        let Some(id) = self.window.filter(|_| self.visible()) else {
            return Task::none();
        };
        if self.share_fullscreen == fullscreen {
            return Task::none();
        }
        self.share_fullscreen = fullscreen;
        let mode = if fullscreen {
            window::Mode::Fullscreen
        } else {
            window::Mode::Windowed
        };
        window::set_mode(id, mode)
    }

    pub fn show(&mut self) -> Task<Message> {
        let was_hidden = std::mem::take(&mut self.hidden);
        match self.window {
            Some(id) => {
                let show = if was_hidden {
                    window::set_mode(id, window::Mode::Windowed)
                } else {
                    Task::none()
                };
                show.chain(window::minimize(id, false))
                    .chain(window::gain_focus(id))
            }
            None => {
                let (id, open) = window::open(self.window_settings.clone());
                self.window = Some(id);
                open.discard()
            }
        }
    }

    pub fn notify(
        &self,
        scope: SessionScope,
        room: RoomId,
        summary: String,
        body: String,
    ) -> Task<Message> {
        if self.focused() {
            return Task::none();
        }
        self.notifications.show(scope, room, summary, body)
    }

    pub fn shutdown(&mut self) -> Task<Message> {
        self.shutting_down = true;
        Task::batch([self.shortcuts.shutdown(), self.tray.shutdown()])
    }

    fn hide(&mut self, actions: &mut Vec<Action>) -> Task<Message> {
        let Some(id) = self
            .window
            .filter(|_| self.tray_available && self.visible())
        else {
            return Task::none();
        };
        self.hidden = true;
        self.share_fullscreen = false;
        self.focused = false;
        self.window_hold = None;
        actions.push(Action::ReleaseLocalHolds);
        // Wayland has no winit visibility operation. Keep the daemon and call
        // alive while replacing its window on the next tray or alert action.
        if self.backend == Some(shortcuts::Backend::Wayland) {
            self.window = None;
            window::close(id)
        } else {
            window::set_mode(id, window::Mode::Hidden)
        }
    }

    fn release_local(&mut self, result: &mut Update) {
        self.focused = false;
        self.window_hold = None;
        result.actions.push(Action::ReleaseLocalHolds);
    }

    fn keyboard(
        &mut self,
        event: keyboard::Event,
        status: event::Status,
        input: &Input<'_>,
        actions: &mut Vec<Action>,
    ) {
        match event {
            keyboard::Event::KeyReleased {
                physical_key: Physical::Code(code),
                ..
            } if self.window_hold == Some(code) => {
                self.window_hold = None;
                actions.push(hold(PttSource::Window, false));
            }
            keyboard::Event::KeyPressed {
                physical_key: Physical::Code(code),
                modifiers,
                repeat: false,
                ..
            } if self.focused()
                && !input.suppress_shortcuts
                && status == event::Status::Ignored
                && !modifiers.control()
                && !modifiers.alt()
                && !modifiers.logo() =>
            {
                let code_name = format!("{code:?}");
                let shortcuts = input.shortcuts;
                if input.push_to_talk && code_name == shortcuts.push_to_talk.code {
                    if input.can_talk() && self.window_hold.is_none() {
                        self.window_press += 1;
                        self.window_hold = Some(code);
                        actions.push(hold(PttSource::Window, true));
                    }
                } else if input.voice.room.is_some() || input.voice.joining.is_some() {
                    if code_name == shortcuts.leave.code {
                        actions.push(if input.voice.room.is_some() {
                            Action::ConfirmVoiceLeave
                        } else {
                            Action::Voice(VoiceAction::Leave)
                        });
                    } else if input.voice.room.is_some() {
                        if code_name == shortcuts.mute.code {
                            actions.push(Action::Voice(VoiceAction::ToggleMute));
                        } else if code_name == shortcuts.deafen.code {
                            actions.push(Action::Voice(VoiceAction::ToggleDeafen));
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn hold(source: PttSource, pressed: bool) -> Action {
    Action::Voice(VoiceAction::PushToTalk(PttAction { source, pressed }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use keyboard::{Key, Location, Modifiers};

    fn press(code: Code, repeat: bool) -> keyboard::Event {
        keyboard::Event::KeyPressed {
            key: Key::Unidentified,
            modified_key: Key::Unidentified,
            physical_key: Physical::Code(code),
            location: Location::Standard,
            modifiers: Modifiers::empty(),
            text: None,
            repeat,
        }
    }

    fn release(code: Code) -> keyboard::Event {
        keyboard::Event::KeyReleased {
            key: Key::Unidentified,
            modified_key: Key::Unidentified,
            physical_key: Physical::Code(code),
            location: Location::Standard,
            modifiers: Modifiers::empty(),
        }
    }

    #[test]
    fn local_hold_ignores_captured_press_and_repeat_but_accepts_captured_release() {
        let voice = VoiceStatus {
            room: Some("room".into()),
            ..Default::default()
        };
        let shortcuts = Shortcuts::default();
        let input = Input {
            voice: &voice,
            shortcuts: &shortcuts,
            can_stop_sharing: false,
            push_to_talk: true,
            suppress_shortcuts: false,
            language: Language::En,
        };
        let (mut platform, _) = Platform::boot(window::Settings::default());
        let id = platform.window().unwrap();
        platform.update(Message(PlatformEvent::Focus(id, true)), &input);
        let mut key = |event, status| {
            platform
                .update(Message(PlatformEvent::Keyboard(id, event, status)), &input)
                .actions
        };

        assert!(key(press(Code::Space, false), event::Status::Captured).is_empty());
        assert_eq!(
            key(press(Code::Space, false), event::Status::Ignored),
            [hold(PttSource::Window, true)]
        );
        assert!(key(press(Code::Space, true), event::Status::Ignored).is_empty());
        assert!(key(release(Code::KeyA), event::Status::Ignored).is_empty());
        assert_eq!(
            key(release(Code::Space), event::Status::Captured),
            [hold(PttSource::Window, false)]
        );
        assert_eq!(
            key(press(Code::KeyM, false), event::Status::Ignored),
            [Action::Voice(VoiceAction::ToggleMute)]
        );
    }

    #[test]
    fn keyboard_leave_confirms_a_call_and_cancels_a_pending_join() {
        let joining = VoiceStatus {
            joining: Some("room".into()),
            ..Default::default()
        };
        let connected = VoiceStatus {
            room: Some("room".into()),
            ..Default::default()
        };
        let shortcuts = Shortcuts::default();
        let input = Input {
            voice: &joining,
            shortcuts: &shortcuts,
            can_stop_sharing: false,
            push_to_talk: false,
            suppress_shortcuts: false,
            language: Language::En,
        };
        let (mut platform, _) = Platform::boot(window::Settings::default());
        let id = platform.window().unwrap();
        platform.update(Message(PlatformEvent::Focus(id, true)), &input);
        let leave = Message(PlatformEvent::Keyboard(
            id,
            press(Code::KeyL, false),
            event::Status::Ignored,
        ));
        assert_eq!(
            platform.update(leave.clone(), &input).actions,
            [Action::Voice(VoiceAction::Leave)]
        );

        let input = Input {
            voice: &connected,
            ..input
        };
        assert_eq!(
            platform.update(leave, &input).actions,
            [Action::ConfirmVoiceLeave]
        );
        assert_eq!(
            platform
                .update(Message(PlatformEvent::Tray(TrayAction::LeaveVoice)), &input)
                .actions,
            [Action::Voice(VoiceAction::Leave)]
        );
    }

    #[test]
    fn focus_loss_releases_local_sources_and_portal_loss_releases_global_source() {
        let voice = VoiceStatus {
            room: Some("room".into()),
            ..Default::default()
        };
        let shortcuts = Shortcuts::default();
        let input = Input {
            voice: &voice,
            shortcuts: &shortcuts,
            can_stop_sharing: false,
            push_to_talk: true,
            suppress_shortcuts: false,
            language: Language::En,
        };
        let (mut platform, _) = Platform::boot(window::Settings::default());
        let id = platform.window().unwrap();
        let _ = platform.sync(&input);
        let generation = platform.shortcuts.generation();
        let mut update = |event| platform.update(Message(event), &input).actions;
        update(PlatformEvent::Focus(id, true));
        update(PlatformEvent::Global(
            generation,
            shortcuts::GlobalEvent::Ready("mock".into()),
        ));
        assert_eq!(
            update(PlatformEvent::Global(
                generation,
                shortcuts::GlobalEvent::Pressed(true)
            )),
            [hold(PttSource::Global, true)]
        );
        assert_eq!(
            update(PlatformEvent::Focus(id, false)),
            [Action::ReleaseLocalHolds]
        );
        assert!(
            update(PlatformEvent::Global(
                generation,
                shortcuts::GlobalEvent::Pressed(true)
            ))
            .is_empty()
        );
        assert_eq!(
            update(PlatformEvent::Global(
                generation,
                shortcuts::GlobalEvent::Failed(GlobalPttStatus::Unavailable)
            )),
            [hold(PttSource::Global, false)]
        );
        assert_eq!(platform.global_ptt_status(), GlobalPttStatus::Unavailable);
    }

    #[test]
    fn in_voice_close_hides_with_tray_and_restores_wayland_after_tray_loss() {
        let voice = VoiceStatus {
            room: Some("room".into()),
            ..Default::default()
        };
        let shortcuts = Shortcuts::default();
        let input = Input {
            voice: &voice,
            shortcuts: &shortcuts,
            can_stop_sharing: false,
            push_to_talk: false,
            suppress_shortcuts: false,
            language: Language::En,
        };
        let (mut platform, _) = Platform::boot(window::Settings::default());
        let id = platform.window().unwrap();
        platform.backend = Some(shortcuts::Backend::Wayland);
        let close = Message(PlatformEvent::CloseRequested(id));
        assert_eq!(
            platform.update(close.clone(), &input).actions,
            [Action::ReleaseLocalHolds, Action::Quit]
        );
        platform.update(Message(PlatformEvent::TrayAvailability(true)), &input);
        let _ = platform.set_share_fullscreen(true);
        platform.update(
            Message(PlatformEvent::Resized(id, iced::Size::new(1920.0, 1080.0))),
            &input,
        );
        assert_eq!(
            platform.update(close, &input).actions,
            [Action::ReleaseLocalHolds]
        );
        assert!(!platform.visible());
        assert_eq!(platform.window(), None);
        platform.update(Message(PlatformEvent::TrayAvailability(false)), &input);
        assert!(platform.visible());
        assert_ne!(platform.window(), Some(id));
        assert!(!platform.share_fullscreen);
        assert_eq!(
            platform.window_settings.size,
            window::Settings::default().size
        );
    }

    #[test]
    fn tray_stop_sharing_leaves_the_call_open() {
        let voice = VoiceStatus {
            room: Some("room".into()),
            ..VoiceStatus::default()
        };
        let shortcuts = Shortcuts::default();
        let input = Input {
            voice: &voice,
            shortcuts: &shortcuts,
            can_stop_sharing: true,
            push_to_talk: false,
            suppress_shortcuts: false,
            language: Language::Uk,
        };
        let (mut platform, _) = Platform::boot(window::Settings::default());
        let stop = Message(PlatformEvent::Tray(TrayAction::StopSharing));

        assert_eq!(
            platform.update(stop.clone(), &input).actions,
            [Action::StopSharing]
        );
        assert!(
            platform
                .update(
                    stop,
                    &Input {
                        can_stop_sharing: false,
                        ..input
                    }
                )
                .actions
                .is_empty()
        );
    }
}
