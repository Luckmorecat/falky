mod live_state;
mod signed_in;

use std::{path::PathBuf, time::Duration};

use falky_core::{
    chat::ReadState,
    live,
    model::{LiveScope, SessionScope, Visitor, VisitorColour, VisitorId},
    session::Authenticated,
    transport::ApiError,
    voice::{VoiceCommand, VoiceJoinError, VoiceNotice, VoiceSnapshot},
};
use iced::{Element, Event, Size, Subscription, Task, Theme, event, keyboard, theme, window};

use crate::{
    chat, locale, login, platform, settings, shell,
    ui_contract::{EffectiveTheme, Language, ShellAction, Viewport, VoiceAction, VoiceStatus},
};

use signed_in::{CaptureReady, Flash, SignedIn, ViewContext, ViewerScope};

const WINDOW_SIZE: Size = Size::new(1100.0, 720.0);

#[derive(Clone, Debug)]
enum Message {
    Login(login::Message),
    Platform(platform::Message),
    Shell(SessionScope, shell::Action),
    ShareViewer(SessionScope, Option<ViewerScope>, shell::ShareAction),
    Chat(SessionScope, chat::Message),
    Settings(SessionScope, settings::Message),
    Live(Box<live::Notice>),
    Colours(
        LiveScope,
        Vec<VisitorId>,
        Result<Vec<VisitorColour>, ApiError>,
    ),
    RetryColours(LiveScope),
    Renamed(SessionScope, Result<Visitor, ApiError>),
    Recoloured(SessionScope, Result<VisitorColour, ApiError>),
    VoiceSnapshot(Box<VoiceSnapshot>),
    VoiceNotice(SessionScope, VoiceNotice),
    CaptureReady(SessionScope, CaptureReady),
    ClearFlash(SessionScope, iced::time::Instant),
    ProbeEditor(window::Id),
    ComposerFocus(SessionScope, bool),
    SystemTheme(theme::Mode),
    Resized(window::Id, Size),
    Key(window::Id, KeyPress),
}

#[derive(Clone, Debug)]
struct KeyPress {
    key: keyboard::Key,
    physical: keyboard::key::Physical,
    modifiers: keyboard::Modifiers,
    status: event::Status,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FixedShortcut {
    Chat,
    PreviousRoom,
    NextRoom,
}

impl KeyPress {
    fn fixed_shortcut(&self) -> Option<FixedShortcut> {
        use keyboard::key::{Code, Named, Physical};

        if self.status != event::Status::Ignored
            || self.modifiers.control()
            || self.modifiers.alt()
            || self.modifiers.logo()
        {
            return None;
        }
        if matches!(&self.key, keyboard::Key::Character(value) if value.as_str() == "/") {
            return Some(FixedShortcut::Chat);
        }
        if !self.modifiers.is_empty() {
            return None;
        }
        match (&self.key, self.physical) {
            (_, Physical::Code(Code::Slash | Code::Enter)) => Some(FixedShortcut::Chat),
            (keyboard::Key::Named(Named::ArrowLeft), _) => Some(FixedShortcut::PreviousRoom),
            (keyboard::Key::Named(Named::ArrowRight), _) => Some(FixedShortcut::NextRoom),
            _ => None,
        }
    }
}

struct App {
    login: login::Login,
    platform: platform::Platform,
    signed_in: Option<SignedIn>,
    preferences: settings::Preferences,
    preferences_unavailable: bool,
    preferences_dirty: bool,
    read_path: Option<PathBuf>,
    system_theme: theme::Mode,
    viewport: Viewport,
    quitting: bool,
}

pub fn run() -> iced::Result {
    iced::daemon(App::boot, App::update, App::view)
        .title("Falky")
        .theme(App::theme)
        .font(shell::ONEST)
        .font(shell::ONEST_NATIVE)
        .font(shell::REACTIONS)
        .default_font(shell::DEFAULT_FONT)
        .subscription(App::subscription)
        .run()
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let (login, login_task) = login::Login::open();
        let (platform, platform_task) = platform::Platform::boot(window::Settings {
            size: WINDOW_SIZE,
            min_size: Some(Size::new(320.0, 420.0)),
            ..window::Settings::default()
        });
        let preferences = settings::Preferences::load();
        let preferences_unavailable = preferences.is_err();
        let read_path = directories::ProjectDirs::from("", "Falky", "Falky")
            .map(|dirs| dirs.config_dir().join("chat-read.json"));
        (
            Self {
                login,
                platform,
                signed_in: None,
                preferences: preferences.unwrap_or_default(),
                preferences_unavailable,
                preferences_dirty: false,
                read_path,
                system_theme: theme::Mode::None,
                viewport: Viewport {
                    width: WINDOW_SIZE.width,
                    height: WINDOW_SIZE.height,
                },
                quitting: false,
            },
            Task::batch([
                login_task.map(Message::Login),
                platform_task.map(Message::Platform),
                iced::system::theme().map(Message::SystemTheme),
            ]),
        )
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        if self.quitting {
            return match message {
                Message::Login(
                    message @ (login::Message::Completed(_) | login::Message::ExitReady),
                ) => self.update_login(message),
                _ => Task::none(),
            };
        }
        let refresh_colours = match &message {
            Message::Live(_) | Message::Chat(_, chat::Message::Finished(..)) => true,
            Message::VoiceSnapshot(snapshot) => self
                .signed_in
                .as_ref()
                .is_some_and(|session| session.voice_roster_changed(snapshot)),
            _ => false,
        };
        let task = match message {
            Message::Login(message) => self.update_login(message),
            Message::Platform(message) => self.update_platform(message),
            Message::Shell(scope, action) if self.is_current(&scope) => self.update_shell(action),
            Message::ShareViewer(scope, Some(source), action)
                if self.is_current(&scope)
                    && self.platform.visible()
                    && self
                        .signed_in
                        .as_ref()
                        .is_some_and(|session| session.accepts_viewer(&source)) =>
            {
                self.update_share(action, Some(source))
            }
            Message::Chat(scope, message) if self.is_current(&scope) => {
                self.update_chat(&scope, message)
            }
            Message::Settings(scope, message) if self.is_current(&scope) => {
                self.update_settings(message)
            }
            Message::Live(notice) => self.update_live(*notice),
            Message::Colours(scope, requested, result) => {
                self.update_colours(&scope, requested, result)
            }
            Message::RetryColours(socket) => self
                .signed_in
                .as_mut()
                .filter(|session| session.live.connected_scope() == Some(&socket))
                .map_or_else(Task::none, SignedIn::sync_visitors),
            Message::Renamed(scope, result) if self.is_current(&scope) => {
                self.finish_rename(&scope, result)
            }
            Message::Recoloured(scope, result) if self.is_current(&scope) => {
                self.finish_colour(&scope, result)
            }
            Message::VoiceSnapshot(snapshot) if self.is_current(&snapshot.scope) => {
                self.update_voice(*snapshot);
                Task::none()
            }
            Message::VoiceNotice(scope, notice) if self.is_current(&scope) => {
                self.update_voice_notice(&scope, notice)
            }
            Message::CaptureReady(scope, ready) if self.is_current(&scope) => {
                let session = self.signed_in.as_mut().expect("current session");
                session
                    .finish_capture(ready)
                    .map_or_else(Task::none, |flash| self.show_flash(&scope, flash))
            }
            Message::ClearFlash(scope, at) if self.is_current(&scope) => {
                let session = self.signed_in.as_mut().expect("current session");
                if session.flash.is_some_and(|(shown, _)| at == shown) {
                    session.flash = None;
                }
                Task::none()
            }
            Message::ProbeEditor(id) if self.platform.window() == Some(id) => self.probe_editor(),
            Message::ComposerFocus(scope, focused) if self.is_current(&scope) => {
                let session = self.signed_in.as_mut().expect("current session");
                session.editor_focused = session.chat_open && focused && self.platform.focused();
                Task::none()
            }
            Message::SystemTheme(mode) => {
                self.system_theme = mode;
                Task::none()
            }
            Message::Resized(id, size) if self.platform.window() == Some(id) => {
                let viewport = Viewport {
                    width: size.width,
                    height: size.height,
                };
                if self.viewport != viewport
                    && let Some(session) = &mut self.signed_in
                {
                    session.release_dock_hold();
                }
                self.viewport = viewport;
                Task::none()
            }
            Message::Key(id, event) if self.platform.window() == Some(id) => self.key(event),
            _ => Task::none(),
        };

        if self.quitting {
            return task;
        }
        let colours = if refresh_colours {
            self.signed_in
                .as_mut()
                .map_or_else(Task::none, SignedIn::sync_visitors)
        } else {
            Task::none()
        };
        let visible = self.platform.visible();
        let fullscreen = self.signed_in.as_mut().is_some_and(|session| {
            session.sync_share(visible);
            session.shell.share_fullscreen()
        });
        let window_mode = self
            .platform
            .set_share_fullscreen(fullscreen)
            .map(Message::Platform);
        let flash = self
            .signed_in
            .as_mut()
            .filter(|_| visible)
            .and_then(|session| {
                session
                    .deferred_share_flash
                    .take()
                    .map(|flash| (session.live.scope.clone(), flash))
            })
            .map_or_else(Task::none, |(scope, flash)| self.show_flash(&scope, flash));
        let input = platform_input(&self.signed_in, &self.preferences);
        let sync = self.platform.sync(&input).map(Message::Platform);
        Task::batch([task, colours, sync, window_mode, flash])
    }

    fn update_login(&mut self, message: login::Message) -> Task<Message> {
        let (task, outcome) = self.login.update(message);
        let follow = match outcome {
            Some(login::Outcome::SignedIn(account)) if !self.quitting => self
                .login
                .authenticated()
                .cloned()
                .map_or_else(Task::none, |mut auth| {
                    auth.account = account;
                    self.start_session(auth)
                }),
            Some(login::Outcome::ExitReady) if self.quitting => self
                .platform
                .shutdown()
                .map(Message::Platform)
                .chain(iced::exit()),
            _ => Task::none(),
        };
        Task::batch([task.map(Message::Login), follow])
    }

    fn start_session(&mut self, auth: Authenticated) -> Task<Message> {
        let read = self
            .read_path
            .as_ref()
            .and_then(|path| {
                ReadState::load(path, &auth.scope.origin, &auth.account.visitor.id).ok()
            })
            .unwrap_or_default();
        let (session, task) = SignedIn::start(auth, &self.preferences, read);
        self.signed_in = Some(session);
        let focused = self.platform.focused();
        let focus = self.chat_action(|chat| chat.set_focused(focused));
        Task::batch([task, focus])
    }

    fn is_current(&self, scope: &SessionScope) -> bool {
        self.signed_in
            .as_ref()
            .is_some_and(|session| &session.live.scope == scope)
    }

    fn revoke(&mut self, scope: &SessionScope) -> Task<Message> {
        if !self.is_current(scope) {
            return Task::none();
        }
        self.retire_session(true);
        self.login.revoke(scope).map(Message::Login)
    }

    fn retire_session(&mut self, clear_read: bool) {
        if let Some(session) = self.signed_in.take() {
            session.voice.command(VoiceCommand::Shutdown);
        }
        if clear_read && let Some(path) = &self.read_path {
            let _ = ReadState::clear(path);
        }
    }

    fn save_read(&mut self, quitting: bool) {
        if let (Some(path), Some(session)) = (&self.read_path, &mut self.signed_in) {
            session.save_read(path, quitting);
        }
    }

    fn save_preferences(&mut self) {
        self.preferences_unavailable = self.preferences.save().is_err();
        self.preferences_dirty = self.preferences_unavailable;
    }

    fn quit(&mut self) -> Task<Message> {
        self.quitting = true;
        if self.preferences_dirty {
            self.save_preferences();
        }
        self.save_read(true);
        self.retire_session(false);
        self.login.exit().map(Message::Login)
    }

    fn update_live(&mut self, notice: live::Notice) -> Task<Message> {
        if let live::Notice::Revoked(scope) = notice {
            return self.revoke(&scope);
        }
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        let scope = session.live.scope.clone();
        match notice {
            live::Notice::Connected(socket) => {
                if session.live.begin(socket.clone()) {
                    session.reset_colour_requests();
                    session.chat.begin_reconnect(&socket);
                }
                Task::none()
            }
            live::Notice::Reconnecting(session_scope) if session_scope == scope => {
                session.live.lose();
                session.chat.invalidate_live();
                session.release_holds();
                Task::none()
            }
            live::Notice::Snapshot(snapshot) => {
                let socket = snapshot.scope.clone();
                if !session.live.install(snapshot) {
                    return Task::none();
                }
                session
                    .chat
                    .update_identity(session.live.account.visitor.clone());
                let select = session.ensure_viewed_room();
                let catch_up = session.chat.sync_after(&socket, &session.live.rooms);
                let attachments = session.chat.refresh_attachments(&socket);
                let tasks = Task::batch([select, catch_up, attachments])
                    .map(move |message| Message::Chat(scope.clone(), message));
                self.save_read(false);
                tasks
            }
            live::Notice::Update(update) if session.live.apply(&update) => {
                let live = session.chat.on_live(&update);
                let room = session.ensure_viewed_room();
                let notify = live
                    .fresh
                    .filter(|_| self.preferences.notifications && !self.platform.focused())
                    .map(|message| {
                        let room_name = session
                            .room(&message.room_id)
                            .map_or("", |room| room.name.as_str());
                        let summary = format!("{} · {room_name}", message.author_name);
                        let language = locale::resolve_language(self.preferences.language);
                        let body = chat::message_summary(&message, language);
                        self.platform
                            .notify(scope.clone(), message.room_id, summary, body)
                            .map(Message::Platform)
                    })
                    .unwrap_or_else(Task::none);
                let chat = Task::batch([live.task, room])
                    .map(move |message| Message::Chat(scope.clone(), message));
                self.save_read(false);
                Task::batch([chat, notify])
            }
            _ => Task::none(),
        }
    }

    fn update_colours(
        &mut self,
        socket: &LiveScope,
        requested: Vec<VisitorId>,
        result: Result<Vec<VisitorColour>, ApiError>,
    ) -> Task<Message> {
        if result.as_ref().is_err_and(ApiError::is_unauthorized) {
            return self.revoke(&socket.session);
        }
        self.signed_in
            .as_mut()
            .filter(|session| session.live.connected_scope() == Some(socket))
            .map_or_else(Task::none, |session| {
                session.finish_colour_request(socket, requested, result)
            })
    }

    fn chat_action(
        &mut self,
        action: impl FnOnce(&mut chat::Chat) -> Task<chat::Message>,
    ) -> Task<Message> {
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        let scope = session.live.scope.clone();
        let task =
            action(&mut session.chat).map(move |message| Message::Chat(scope.clone(), message));
        self.save_read(false);
        task
    }

    fn update_chat(&mut self, scope: &SessionScope, message: chat::Message) -> Task<Message> {
        let session = self.signed_in.as_mut().expect("current session");
        if matches!(
            &message,
            chat::Message::EditInput(_)
                | chat::Message::Reply(_)
                | chat::Message::Edit(_)
                | chat::Message::EditLast
        ) {
            session.editor_focused = self.platform.focused();
        }
        let update = session.chat.update(message);
        if let Some(unauthorized) = update.unauthorized {
            return self.revoke(&unauthorized);
        }
        let close = if update.close {
            session.chat_open = false;
            session.editor_focused = false;
            session.chat.set_open(false)
        } else {
            Task::none()
        };
        let scope = scope.clone();
        self.save_read(false);
        Task::batch([update.task, close]).map(move |message| Message::Chat(scope.clone(), message))
    }

    fn open_chat(&mut self, open: bool) -> Task<Message> {
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        session.chat_open = open;
        session.editor_focused = open && self.platform.focused();
        self.chat_action(|chat| {
            let task = chat.set_open(open);
            if open {
                Task::batch([task, chat.focus()])
            } else {
                task
            }
        })
    }

    fn select_room(&mut self, room: &falky_core::model::RoomId) -> Task<Message> {
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        if session.room(room).is_none() {
            return Task::none();
        }
        session.shell.update(shell::Action::CloseRooms);
        let scope = session.live.scope.clone();
        let task = session.select_room(Some(room.clone()));
        self.save_read(false);
        task.map(move |message| Message::Chat(scope.clone(), message))
    }

    fn update_shell(&mut self, action: shell::Action) -> Task<Message> {
        let session = self.signed_in.as_mut().expect("current session");
        let confirm_leave =
            matches!(action, shell::Action::ConfirmLeave) && session.shell.modal_open();
        if let shell::Action::Share(action) = action {
            return self.update_share(action, None);
        }
        session.shell.update(action.clone());
        match action {
            shell::Action::Intent(ShellAction::ViewRoom(room)) => self.select_room(&room),
            shell::Action::Intent(ShellAction::ToggleChat) => {
                let open = !session.chat_open;
                self.open_chat(open)
            }
            shell::Action::Intent(ShellAction::OpenSettings) => {
                let action = session.settings.open(&session.live.account.visitor);
                self.settings_action(action)
            }
            shell::Action::Intent(ShellAction::Voice(action)) => {
                session.voice_action(action, self.preferences.voice.push_to_talk);
                Task::none()
            }
            shell::Action::ConfirmLeave if confirm_leave => {
                session.voice_action(VoiceAction::Leave, self.preferences.voice.push_to_talk);
                Task::none()
            }
            _ => Task::none(),
        }
    }

    fn update_share(
        &mut self,
        action: shell::ShareAction,
        viewer: Option<ViewerScope>,
    ) -> Task<Message> {
        use shell::ShareAction;

        let session = self.signed_in.as_mut().expect("current session");
        if let Some(command) = viewer.and_then(|viewer| viewer.watch_command(&action)) {
            session.voice.command(command);
        }
        session.shell.update(shell::Action::Share(action.clone()));
        match action {
            ShareAction::ToggleCapture => {
                let window = self.platform.window().filter(|_| self.platform.visible());
                return session.toggle_capture(window, self.preferences.share);
            }
            ShareAction::Watch(_) | ShareAction::StopWatching => {}
            ShareAction::Volume(_) | ShareAction::ToggleVolumeMute => {
                let volume = &mut self.preferences.share_volume;
                let previous = *volume;
                if let ShareAction::Volume(percent) = action {
                    volume.set_percent(percent);
                } else {
                    volume.toggle_mute();
                }
                if *volume != previous {
                    session
                        .voice
                        .command(VoiceCommand::ShareGain(volume.percent()));
                    self.save_preferences();
                }
            }
            ShareAction::ToggleFullscreen => {
                session.release_dock_hold();
                session.editor_focused = false;
            }
            ShareAction::PointerMoved => {}
        }
        Task::none()
    }

    fn update_platform(&mut self, message: platform::Message) -> Task<Message> {
        let focused = self.platform.focused();
        let input = platform_input(&self.signed_in, &self.preferences);
        let update = self.platform.update(message, &input);
        let mut tasks = vec![update.task.map(Message::Platform)];
        if focused != self.platform.focused() {
            let focused = self.platform.focused();
            tasks.push(self.chat_action(|chat| chat.set_focused(focused)));
            if focused {
                tasks.push(self.probe_editor());
            } else if let Some(session) = &mut self.signed_in {
                session.editor_focused = false;
            }
        }
        for action in update.actions {
            match action {
                platform::Action::Voice(action) => {
                    if let Some(session) = &mut self.signed_in {
                        session.voice_action(action, self.preferences.voice.push_to_talk);
                    }
                }
                platform::Action::StopSharing => {
                    if let Some(session) = &mut self.signed_in {
                        session.stop_sharing();
                    }
                }
                platform::Action::ConfirmVoiceLeave => {
                    if let Some(session) = &mut self.signed_in {
                        session.shell.exit_share_fullscreen();
                        session.shell.update(shell::Action::RequestLeave);
                    }
                }
                platform::Action::ReleaseLocalHolds => {
                    if let Some(session) = &mut self.signed_in {
                        session.release_local_holds();
                    }
                    tasks.push(self.update_settings(settings::Message::CancelCapture));
                }
                platform::Action::Quit => tasks.push(self.quit()),
                platform::Action::NotificationOpened { scope, room } if self.is_current(&scope) => {
                    tasks.extend([
                        self.platform.show().map(Message::Platform),
                        self.select_room(&room),
                        self.open_chat(true),
                    ]);
                }
                _ => {}
            }
        }
        Task::batch(tasks)
    }

    fn update_settings(&mut self, message: settings::Message) -> Task<Message> {
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        if let settings::Message::InputDevice(id) = &message
            && id != &self.preferences.voice.mic_id
        {
            session.release_holds();
        }
        let action = session.settings.update(
            message,
            &mut self.preferences,
            &session.live.account.visitor,
            &session.audio,
        );
        self.settings_action(action)
    }

    fn settings_action(&mut self, action: Option<settings::Action>) -> Task<Message> {
        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        let scope = session.live.scope.clone();
        match action {
            Some(settings::Action::PreferencesChanged) => {
                session.send_settings(&self.preferences);
                self.save_preferences();
            }
            Some(settings::Action::RefreshDevices) => {
                session.voice.command(VoiceCommand::RefreshDevices);
            }
            Some(settings::Action::MicTest(enabled)) => {
                session.voice.command(VoiceCommand::MicTest(enabled));
            }
            Some(settings::Action::SpeakerTest) => {
                session.voice.command(VoiceCommand::SpeakerTest);
            }
            Some(settings::Action::OpenAccessibilitySettings) => {
                platform::Platform::open_accessibility_settings();
            }
            Some(settings::Action::SignOut) => {
                self.retire_session(true);
                return self.login.sign_out().map(Message::Login);
            }
            Some(settings::Action::CopyAccountId(id)) => return iced::clipboard::write(id),
            Some(settings::Action::Rename(name)) => {
                let client = session.api.clone();
                return Task::perform(
                    async move { falky_core::preferences::rename(&client, &name).await },
                    move |result| Message::Renamed(scope, result),
                );
            }
            Some(settings::Action::SetColour(palette)) => {
                let client = session.api.clone();
                return Task::perform(
                    async move { falky_core::preferences::set_colour(&client, palette).await },
                    move |result| Message::Recoloured(scope, result),
                );
            }
            None => {}
        }
        Task::none()
    }

    fn finish_rename(
        &mut self,
        scope: &SessionScope,
        result: Result<Visitor, ApiError>,
    ) -> Task<Message> {
        if result.as_ref().is_err_and(ApiError::is_unauthorized) {
            return self.revoke(scope);
        }
        let session = self.signed_in.as_mut().expect("current session");
        let result = result.map(|visitor| {
            session.live.rename(visitor);
            session
                .chat
                .update_identity(session.live.account.visitor.clone());
        });
        self.update_settings(settings::Message::RenameFinished(
            result.map_err(|error| settings::ProfileError::from(&error)),
        ))
    }

    fn finish_colour(
        &mut self,
        scope: &SessionScope,
        result: Result<VisitorColour, ApiError>,
    ) -> Task<Message> {
        if result.as_ref().is_err_and(ApiError::is_unauthorized) {
            return self.revoke(scope);
        }
        let session = self.signed_in.as_mut().expect("current session");
        let result = result.map(|assignment| session.live.merge_colour(assignment));
        self.update_settings(settings::Message::ColourFinished(
            result.map_err(|error| settings::ProfileError::from(&error)),
        ))
    }

    fn update_voice(&mut self, snapshot: VoiceSnapshot) {
        let session = self.signed_in.as_mut().expect("current session");
        let scope = session.live.scope.clone();
        let mut gains_changed = false;
        for (id, percent) in &snapshot.gains {
            if session.gains.get(id).copied().unwrap_or(100) != *percent {
                self.preferences
                    .set_gain(&scope.origin, id.clone(), *percent);
                gains_changed = true;
            }
        }
        session.update_voice(snapshot);
        if gains_changed {
            self.save_preferences();
        }
    }

    fn update_voice_notice(&mut self, scope: &SessionScope, notice: VoiceNotice) -> Task<Message> {
        let session = self.signed_in.as_mut().expect("current session");
        let share_notice = matches!(
            notice,
            VoiceNotice::ShareSourceLost
                | VoiceNotice::SharePublishFailed
                | VoiceNotice::ShareAudioUnavailable
        );
        let flash = match notice {
            VoiceNotice::JoinFailed {
                error: VoiceJoinError::Admission(error),
                ..
            } if error.is_unauthorized() => return self.revoke(scope),
            VoiceNotice::JoinFailed { error, .. } => Flash::join_error(error),
            VoiceNotice::AwayMuted { minutes } => Flash::Away(minutes),
            VoiceNotice::Disconnected => {
                session.release_holds();
                Flash::ConnectionLost
            }
            VoiceNotice::ShareSourceLost => {
                session.share_failed();
                Flash::Notice(locale::Key::ShareSourceLost)
            }
            VoiceNotice::SharePublishFailed => {
                session.share_failed();
                Flash::Notice(locale::Key::SharePublishFailed)
            }
            VoiceNotice::ShareAudioUnavailable => Flash::Notice(locale::Key::ShareAudioUnavailable),
        };
        if share_notice && !self.platform.visible() {
            session.deferred_share_flash = Some(flash);
            Task::none()
        } else {
            self.show_flash(scope, flash)
        }
    }

    fn show_flash(&mut self, scope: &SessionScope, flash: Flash) -> Task<Message> {
        let at = iced::time::Instant::now();
        self.signed_in.as_mut().expect("current session").flash = Some((at, flash));
        let scope = scope.clone();
        Task::perform(tokio::time::sleep(Duration::from_secs(5)), move |()| {
            Message::ClearFlash(scope, at)
        })
    }

    fn probe_editor(&self) -> Task<Message> {
        let Some(session) = self.signed_in.as_ref().filter(|session| session.chat_open) else {
            return Task::none();
        };
        let scope = session.live.scope.clone();
        iced::widget::operation::is_focused(chat::composer_id())
            .map(move |focused| Message::ComposerFocus(scope.clone(), focused))
    }

    fn key(&mut self, event: KeyPress) -> Task<Message> {
        use keyboard::key::Named;

        let Some(session) = &mut self.signed_in else {
            return Task::none();
        };
        if event.key == keyboard::Key::Named(Named::Escape) && session.shell.exit_share_fullscreen()
        {
            return Task::none();
        }
        if session.settings.is_capturing_shortcut() {
            return self.update_settings(settings::Message::Capture(event.physical));
        }
        if event.key == keyboard::Key::Named(Named::Escape) {
            if session.settings.is_open() {
                return self.update_settings(settings::Message::Close);
            }
            if !session.chat.modal_open() {
                if session.shell.modal_open() {
                    session.shell.update(shell::Action::Dismiss);
                } else if session.shell.room_strip_open() {
                    session.shell.update(shell::Action::CloseRooms);
                }
            }
            return Task::none();
        }
        if event.key == keyboard::Key::Named(Named::Tab) {
            return self.probe_editor();
        }
        if !self.platform.focused() || session.uses_keyboard() || session.shell.share_fullscreen() {
            return Task::none();
        }
        match event.fixed_shortcut() {
            Some(FixedShortcut::Chat) if !session.live.rooms.is_empty() => self.open_chat(true),
            Some(direction @ (FixedShortcut::PreviousRoom | FixedShortcut::NextRoom)) => {
                let next = session.adjacent_room(direction == FixedShortcut::NextRoom);
                next.map_or_else(Task::none, |room| self.select_room(&room))
            }
            _ => Task::none(),
        }
    }

    fn language(&self) -> Language {
        locale::resolve_language(self.preferences.language)
    }

    fn effective_theme(&self) -> EffectiveTheme {
        locale::resolve_theme(self.preferences.theme, self.system_theme)
    }

    fn theme(&self, _: window::Id) -> Theme {
        shell::theme(self.effective_theme())
    }

    fn view(&self, _: window::Id) -> Element<'_, Message> {
        let language = self.language();
        let Some(session) = &self.signed_in else {
            return self.login.view(language).map(Message::Login);
        };
        session.view(ViewContext {
            preferences: &self.preferences,
            preferences_unavailable: self.preferences_unavailable,
            platform: &self.platform,
            theme: self.effective_theme(),
            language,
            viewport: self.viewport,
            storage_notice: self.login.storage_notice(language),
            #[cfg(test)]
            share_frame: None,
        })
    }

    fn subscription(&self) -> Subscription<Message> {
        let shell = self
            .signed_in
            .as_ref()
            .map_or_else(Subscription::none, |session| {
                if self.platform.visible() {
                    session.shell_subscription(
                        self.effective_theme(),
                        self.language(),
                        self.viewport,
                    )
                } else {
                    Subscription::none()
                }
            });
        let chat = self
            .signed_in
            .as_ref()
            .map_or_else(Subscription::none, |session| {
                let scope = session.live.scope.clone();
                session
                    .chat
                    .subscription()
                    .with(scope)
                    .map(|(scope, message)| Message::Chat(scope, message))
            });
        Subscription::batch([
            self.login.subscription().map(Message::Login),
            self.platform.subscription().map(Message::Platform),
            iced::system::theme_changes().map(Message::SystemTheme),
            window::resize_events().map(|(id, size)| Message::Resized(id, size)),
            event::listen_with(|event, status, id| match event {
                Event::Window(window::Event::Opened { size, .. }) => {
                    Some(Message::Resized(id, size))
                }
                Event::Mouse(iced::mouse::Event::ButtonPressed(iced::mouse::Button::Left))
                | Event::Touch(iced::touch::Event::FingerPressed { .. }) => {
                    Some(Message::ProbeEditor(id))
                }
                Event::Keyboard(keyboard::Event::KeyPressed {
                    key,
                    physical_key,
                    modifiers,
                    repeat: false,
                    ..
                }) => Some(Message::Key(
                    id,
                    KeyPress {
                        key,
                        physical: physical_key,
                        modifiers,
                        status,
                    },
                )),
                _ => None,
            }),
            shell,
            chat,
        ])
    }
}

// Splitting these borrows lets Platform consume changes while reading the current app inputs.
fn platform_input<'a>(
    signed_in: &'a Option<SignedIn>,
    preferences: &'a settings::Preferences,
) -> platform::Input<'a> {
    static IDLE: VoiceStatus = VoiceStatus {
        room: None,
        joining: None,
        muted: true,
        deafened: false,
        ptt_held: false,
        listen_only: false,
        mic_level: 0.0,
    };
    platform::Input {
        voice: signed_in
            .as_ref()
            .map_or(&IDLE, |session| &session.voice_status),
        shortcuts: &preferences.shortcuts,
        can_stop_sharing: signed_in.as_ref().is_some_and(SignedIn::can_stop_sharing),
        push_to_talk: signed_in.is_some() && preferences.voice.push_to_talk,
        suppress_shortcuts: signed_in.as_ref().is_none_or(SignedIn::uses_keyboard),
        language: locale::resolve_language(preferences.language),
    }
}

#[cfg(test)]
mod key_tests {
    use keyboard::key::{Code, Named, Physical};

    use super::*;

    #[test]
    fn opens_chat_on_a_physical_slash_or_an_unhandled_enter() {
        let mut press = KeyPress {
            key: keyboard::Key::Character("ж".into()),
            physical: Physical::Code(Code::Slash),
            modifiers: keyboard::Modifiers::empty(),
            status: event::Status::Ignored,
        };
        assert_eq!(press.fixed_shortcut(), Some(FixedShortcut::Chat));

        press.key = keyboard::Key::Named(Named::Enter);
        press.physical = Physical::Code(Code::Enter);
        assert_eq!(press.fixed_shortcut(), Some(FixedShortcut::Chat));
        press.status = event::Status::Captured;
        assert_eq!(press.fixed_shortcut(), None);
    }

    #[test]
    fn room_arrows_require_an_unhandled_key_without_modifiers() {
        let mut press = KeyPress {
            key: keyboard::Key::Named(Named::ArrowLeft),
            physical: Physical::Code(Code::ArrowLeft),
            modifiers: keyboard::Modifiers::empty(),
            status: event::Status::Ignored,
        };
        assert_eq!(press.fixed_shortcut(), Some(FixedShortcut::PreviousRoom));
        press.key = keyboard::Key::Named(Named::ArrowRight);
        press.physical = Physical::Code(Code::ArrowRight);
        assert_eq!(press.fixed_shortcut(), Some(FixedShortcut::NextRoom));
        press.modifiers = keyboard::Modifiers::SHIFT;
        assert_eq!(press.fixed_shortcut(), None);
        press.modifiers = keyboard::Modifiers::CTRL;
        assert_eq!(press.fixed_shortcut(), None);
    }
}
