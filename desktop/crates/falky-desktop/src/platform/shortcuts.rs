use super::{Events, Message, PlatformEvent};
use crate::ui_contract::GlobalPttStatus;
use iced::{Task, window};
use std::time::Duration;
use tokio::sync::{oneshot, watch};

const DISPLAY_TRIGGER: &str = "Ctrl+Shift+F9";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Backend {
    #[cfg(target_os = "linux")]
    X11,
    Wayland,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Native,
    Unavailable,
}

impl Backend {
    pub(super) fn detect(window: &dyn window::Window) -> Self {
        use window::raw_window_handle::RawWindowHandle;

        match window.window_handle().map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::Wayland(_)) => Self::Wayland,
            #[cfg(target_os = "linux")]
            Ok(RawWindowHandle::Xlib(_) | RawWindowHandle::Xcb(_)) => Self::X11,
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            Ok(RawWindowHandle::AppKit(_) | RawWindowHandle::Win32(_)) => Self::Native,
            _ => Self::Unavailable,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum GlobalEvent {
    Ready(String),
    Pressed(bool),
    Failed(GlobalPttStatus),
}

#[derive(Default)]
pub(super) struct Global {
    enabled: bool,
    generation: u64,
    held: bool,
    status: GlobalPttStatus,
    trigger: Option<String>,
    service: Option<Service>,
}

struct Service {
    request: watch::Sender<Option<u64>>,
    done: oneshot::Receiver<()>,
}

impl Global {
    pub(super) fn start(&mut self, backend: Backend, events: Events) -> Task<Message> {
        if self.service.is_some() {
            return Task::none();
        }
        let (request, receive) = watch::channel(self.enabled.then_some(self.generation));
        let (done, completion) = oneshot::channel();
        self.service = Some(Service {
            request,
            done: completion,
        });
        Task::future(async move {
            supervise(backend, events, receive).await;
            let _ = done.send(());
        })
        .discard()
    }

    pub(super) fn configure(&mut self, enabled: bool) -> bool {
        if enabled == self.enabled {
            return false;
        }
        self.enabled = enabled;
        self.status = GlobalPttStatus::Inactive;
        self.trigger = None;
        self.request();
        std::mem::take(&mut self.held)
    }

    pub(super) fn update(&mut self, generation: u64, event: GlobalEvent) -> Option<bool> {
        if !self.enabled || self.generation != generation {
            return None;
        }
        match event {
            GlobalEvent::Ready(trigger) => {
                self.status = GlobalPttStatus::Available;
                self.trigger = Some(trigger);
                None
            }
            GlobalEvent::Pressed(pressed)
                if self.status == GlobalPttStatus::Available && self.held != pressed =>
            {
                self.held = pressed;
                Some(pressed)
            }
            GlobalEvent::Failed(status) => {
                self.status = status;
                self.trigger = None;
                std::mem::take(&mut self.held).then_some(false)
            }
            GlobalEvent::Pressed(_) => None,
        }
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn status(&self) -> GlobalPttStatus {
        self.status
    }

    pub(super) fn trigger(&self) -> Option<&str> {
        self.trigger.as_deref()
    }

    pub(super) fn retry_after_accessibility(&mut self) {
        #[cfg(target_os = "macos")]
        if self.status == GlobalPttStatus::AccessibilityRequired
            && handy_keys::check_accessibility()
        {
            self.request();
        }
    }

    pub(super) fn shutdown(&mut self) -> Task<Message> {
        let Some(Service { request, done }) = self.service.take() else {
            return Task::none();
        };
        drop(request);
        Task::future(async move {
            let _ = tokio::time::timeout(Duration::from_secs(2), done).await;
        })
        .discard()
    }

    fn request(&mut self) {
        self.generation += 1;
        if let Some(service) = &self.service {
            service
                .request
                .send_replace(self.enabled.then_some(self.generation));
        }
    }
}

pub(super) fn open_accessibility_settings() {
    #[cfg(target_os = "macos")]
    if let Err(error) = handy_keys::open_accessibility_settings() {
        eprintln!("Falky could not open Accessibility settings: {error}");
    }
}

#[derive(Clone)]
struct Reporter {
    events: Events,
    generation: u64,
}

impl Reporter {
    fn send(&self, event: GlobalEvent) {
        let _ = self
            .events
            .send(Message(PlatformEvent::Global(self.generation, event)));
    }
}

async fn supervise(backend: Backend, events: Events, mut request: watch::Receiver<Option<u64>>) {
    loop {
        let active = *request.borrow_and_update();
        if let Some(generation) = active {
            let report = Reporter {
                events: events.clone(),
                generation,
            };
            let failure = match backend {
                #[cfg(target_os = "linux")]
                Backend::Wayland => portal(&mut request, &report).await,
                #[cfg(target_os = "linux")]
                Backend::X11 => x11(&mut request, &report).await,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                Backend::Native => native(request.clone(), report.clone()).await,
                _ => Some(GlobalPttStatus::Unavailable),
            };
            if let Some(status) = failure {
                report.send(GlobalEvent::Failed(status));
            }
        }
        if *request.borrow() == active && request.changed().await.is_err() {
            break;
        }
    }
}

#[cfg(target_os = "linux")]
async fn x11(
    request: &mut watch::Receiver<Option<u64>>,
    report: &Reporter,
) -> Option<GlobalPttStatus> {
    use global_hotkey::hotkey::{Code, HotKey, Modifiers};
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

    let hotkey = HotKey::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F9);
    let manager = match GlobalHotKeyManager::new().and_then(|manager| {
        manager.register(hotkey)?;
        Ok(manager)
    }) {
        Ok(manager) => manager,
        Err(error) => {
            eprintln!("Falky could not register the X11 push-to-talk shortcut: {error}");
            return Some(GlobalPttStatus::Unavailable);
        }
    };
    let events = GlobalHotKeyEvent::receiver();
    // A previous registration may still have queued events when the user toggles PTT.
    while events.try_recv().is_ok() {}
    report.send(GlobalEvent::Ready(DISPLAY_TRIGGER.into()));
    let mut poll = tokio::time::interval(Duration::from_millis(16));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = request.changed() => break,
            _ = poll.tick() => {
                for event in events.try_iter().filter(|event| event.id() == hotkey.id()) {
                    report.send(GlobalEvent::Pressed(event.state() == HotKeyState::Pressed));
                }
            }
        }
    }
    let _ = manager.unregister(hotkey);
    None
}

#[cfg(target_os = "linux")]
async fn portal(
    request: &mut watch::Receiver<Option<u64>>,
    report: &Reporter,
) -> Option<GlobalPttStatus> {
    use ashpd::zbus;

    // Use a connection dedicated to this registration, so ending it also
    // cancels a portal request that is still awaiting a compositor response.
    let connection = tokio::select! {
        _ = request.changed() => return None,
        result = tokio::time::timeout(Duration::from_secs(5), zbus::Connection::session()) => {
            match result {
                Ok(Ok(connection)) => connection,
                _ => return Some(GlobalPttStatus::Unavailable),
            }
        }
    };
    let result = tokio::select! {
        biased;
        _ = request.changed() => None,
        result = portal_session(connection.clone(), report) => {
            if let Err(error) = result {
                eprintln!("Falky global push-to-talk portal unavailable: {error}");
            }
            Some(GlobalPttStatus::Unavailable)
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(1), connection.close()).await;
    result
}

#[cfg(target_os = "linux")]
async fn portal_session(
    connection: ashpd::zbus::Connection,
    report: &Reporter,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use ashpd::desktop::CreateSessionOptions;
    use ashpd::desktop::global_shortcuts::{
        Activated, BindShortcutsOptions, Deactivated, GlobalShortcuts, NewShortcut,
        ShortcutsChanged,
    };
    use futures_util::{StreamExt, pin_mut};

    const SHORTCUT: &str = "falky-push-to-talk";
    let portal = GlobalShortcuts::with_connection(connection).await?;
    let mut owner = portal.receive_owner_changed().await?;
    let session = tokio::time::timeout(
        Duration::from_secs(5),
        portal.create_session(CreateSessionOptions::default()),
    )
    .await??;
    let session_path: String = serde_json::from_value(serde_json::to_value(&session)?)?;
    // A single stream preserves D-Bus order when down and up arrive together.
    let mut signals = portal.receive_all_signals().await?;
    let closed = session.receive_closed().await?;
    pin_mut!(closed);

    let shortcuts =
        [NewShortcut::new(SHORTCUT, "Falky push to talk").preferred_trigger("CTRL+SHIFT+F9")];
    let response = tokio::select! {
        _ = owner.next() => return Ok(()),
        _ = closed.next() => return Ok(()),
        result = tokio::time::timeout(
            Duration::from_secs(120),
            portal.bind_shortcuts(&session, &shortcuts, None, BindShortcutsOptions::default()),
        ) => result??.response()?,
    };
    let Some(binding) = response
        .shortcuts()
        .iter()
        .find(|binding| binding.id() == SHORTCUT)
    else {
        return Ok(());
    };
    report.send(GlobalEvent::Ready(binding.trigger_description().to_owned()));
    loop {
        let message = tokio::select! {
            biased;
            _ = owner.next() => break,
            _ = closed.next() => break,
            event = signals.next() => match event {
                Some(event) => event,
                None => break,
            },
        };
        let header = message.header();
        match header.member().map(|member| member.as_str()) {
            Some("Activated") => {
                let signal: Activated = message.body().deserialize()?;
                if signal.session_handle().as_str() == session_path
                    && signal.shortcut_id() == SHORTCUT
                {
                    report.send(GlobalEvent::Pressed(true));
                }
            }
            Some("Deactivated") => {
                let signal: Deactivated = message.body().deserialize()?;
                if signal.session_handle().as_str() == session_path
                    && signal.shortcut_id() == SHORTCUT
                {
                    report.send(GlobalEvent::Pressed(false));
                }
            }
            Some("ShortcutsChanged") => {
                let signal: ShortcutsChanged = message.body().deserialize()?;
                if signal.session_handle().as_str() == session_path {
                    let Some(binding) = signal
                        .shortcuts()
                        .iter()
                        .find(|binding| binding.id() == SHORTCUT)
                    else {
                        break;
                    };
                    report.send(GlobalEvent::Pressed(false));
                    report.send(GlobalEvent::Ready(binding.trigger_description().to_owned()));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn native(
    request: watch::Receiver<Option<u64>>,
    report: Reporter,
) -> Option<GlobalPttStatus> {
    tokio::task::spawn_blocking(move || native_listener(request, report))
        .await
        .unwrap_or(Some(GlobalPttStatus::Unavailable))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn native_listener(
    request: watch::Receiver<Option<u64>>,
    report: Reporter,
) -> Option<GlobalPttStatus> {
    use handy_keys::{Error, Key, KeyboardListener, Modifiers};

    let listener = match KeyboardListener::new() {
        Ok(listener) => listener,
        Err(Error::AccessibilityNotGranted) => return Some(GlobalPttStatus::AccessibilityRequired),
        Err(error) => {
            eprintln!("Falky could not start its push-to-talk shortcut: {error}");
            return Some(GlobalPttStatus::Unavailable);
        }
    };
    report.send(GlobalEvent::Ready(DISPLAY_TRIGGER.into()));
    let chord = Modifiers::CTRL | Modifiers::SHIFT;
    let mut held = false;
    let mut key_down = false;
    #[cfg(target_os = "macos")]
    let mut checked_accessibility = std::time::Instant::now();
    while *request.borrow() == Some(report.generation) && request.has_changed().is_ok() {
        #[cfg(target_os = "macos")]
        if checked_accessibility.elapsed() >= Duration::from_secs(1) {
            if !handy_keys::check_accessibility() {
                return Some(GlobalPttStatus::AccessibilityRequired);
            }
            checked_accessibility = std::time::Instant::now();
        }
        let event = match listener.recv_timeout(Duration::from_millis(100)) {
            Ok(event) => event,
            Err(Error::Timeout) => continue,
            Err(_) => return Some(GlobalPttStatus::Unavailable),
        };
        if event.key == Some(Key::F9) {
            if event.is_key_down && !key_down && chord.matches(event.modifiers) {
                held = true;
                report.send(GlobalEvent::Pressed(true));
            }
            key_down = event.is_key_down;
        }
        if held && (!key_down || !chord.matches(event.modifiers)) {
            held = false;
            report.send(GlobalEvent::Pressed(false));
        }
    }
    None
}
