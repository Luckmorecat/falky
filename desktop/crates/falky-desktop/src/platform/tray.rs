use super::{Events, Input, Message, PlatformEvent};
use crate::ui_contract::{Language, TrayAction};
use iced::Task;

#[derive(Default)]
pub(super) struct Tray {
    snapshot: Snapshot,
    started: bool,
    service: Option<os::Service>,
}

impl Tray {
    pub(super) fn start(&mut self, events: Events) -> Task<Message> {
        if self.started {
            return Task::none();
        }
        self.started = true;
        let (service, task) = os::start(self.snapshot, events);
        self.service = service;
        task
    }

    pub(super) fn sync(&mut self, snapshot: Snapshot) {
        if self.snapshot != snapshot {
            self.snapshot = snapshot;
            if let Some(service) = &self.service {
                service.sync(snapshot);
            }
        }
    }

    pub(super) fn shutdown(&mut self) -> Task<Message> {
        self.service
            .take()
            .map_or_else(Task::none, os::Service::shutdown)
    }
}

#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub(super) struct Snapshot {
    visible: bool,
    in_voice: bool,
    muted: bool,
    deafened: bool,
    language: Language,
}

impl Snapshot {
    pub(super) fn new(visible: bool, input: &Input<'_>) -> Self {
        let in_voice = input.voice.room.is_some();
        Self {
            visible,
            in_voice,
            muted: in_voice && input.voice.muted,
            deafened: in_voice && input.voice.deafened,
            language: input.language,
        }
    }

    fn entries(self) -> [(TrayAction, &'static str, bool); 5] {
        let (visibility, visibility_label) = match (self.visible, self.language) {
            (true, Language::En) => (TrayAction::Hide, "Hide Falky"),
            (false, Language::En) => (TrayAction::Show, "Show Falky"),
            (true, Language::Uk) => (TrayAction::Hide, "Сховати Falky"),
            (false, Language::Uk) => (TrayAction::Show, "Показати Falky"),
        };
        let (mute, deafen, leave, quit) = match self.language {
            Language::En => (
                if self.muted {
                    "Unmute microphone"
                } else {
                    "Mute microphone"
                },
                if self.deafened { "Undeafen" } else { "Deafen" },
                "Leave voice",
                "Quit",
            ),
            Language::Uk => (
                if self.muted {
                    "Увімкнути мікрофон"
                } else {
                    "Вимкнути мікрофон"
                },
                if self.deafened {
                    "Увімкнути звук"
                } else {
                    "Вимкнути звук"
                },
                "Вийти з голосу",
                "Вийти з Falky",
            ),
        };
        [
            (visibility, visibility_label, true),
            (
                TrayAction::ToggleMute,
                mute,
                self.in_voice && !self.deafened,
            ),
            (TrayAction::ToggleDeafen, deafen, self.in_voice),
            (TrayAction::LeaveVoice, leave, self.in_voice),
            (TrayAction::Quit, quit, true),
        ]
    }
}

const ICON_SIZE: u32 = 32;

fn icon_rgba() -> Vec<u8> {
    let size = ICON_SIZE as f32;
    (0..ICON_SIZE * ICON_SIZE)
        .flat_map(|index| {
            let x = (index % ICON_SIZE) as f32 + 0.5;
            let y = (index / ICON_SIZE) as f32 + 0.5;
            let nx = ((x - size / 2.0) / 15.0).abs();
            let ny = ((y - size / 2.0) / 15.0).abs();
            let edge = (nx.powf(3.4) + ny.powf(3.4)).powf(1.0 / 3.4);
            let alpha = ((1.0 - edge) * size + 0.5).clamp(0.0, 1.0);
            let radius = (x - size * 0.42).hypot(y - size * 0.62) / (size * 0.62);
            let (inner, outer, blend) = if radius < 0.45 {
                ([243.0, 250.0, 247.0], [169.0, 215.0, 247.0], radius / 0.45)
            } else {
                (
                    [169.0, 215.0, 247.0],
                    [75.0, 150.0, 239.0],
                    ((radius - 0.45) / 0.55).min(1.0),
                )
            };
            let channel = |i: usize| (inner[i] + (outer[i] - inner[i]) * blend) as u8;
            [channel(0), channel(1), channel(2), (255.0 * alpha) as u8]
        })
        .collect()
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use ashpd::zbus::{self, proxy::CacheProperties};
    use ksni::{TrayMethods, menu::StandardItem};
    use std::time::Duration;
    use tokio::sync::watch;

    pub(super) struct Service {
        snapshot: watch::Sender<Snapshot>,
        done: tokio::sync::oneshot::Receiver<()>,
    }

    impl Service {
        pub(super) fn sync(&self, snapshot: Snapshot) {
            self.snapshot.send_replace(snapshot);
        }

        pub(super) fn shutdown(self) -> Task<Message> {
            drop(self.snapshot);
            Task::future(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), self.done).await;
            })
            .discard()
        }
    }

    pub(super) fn start(snapshot: Snapshot, events: Events) -> (Option<Service>, Task<Message>) {
        let (snapshot, updates) = watch::channel(snapshot);
        let (done, completion) = tokio::sync::oneshot::channel();
        let process = Task::future(async move {
            serve(updates, events).await;
            let _ = done.send(());
        });
        (
            Some(Service {
                snapshot,
                done: completion,
            }),
            process.discard(),
        )
    }

    async fn serve(mut snapshots: watch::Receiver<Snapshot>, events: Events) {
        let (watcher, mut availability) = watch::channel(true);
        let tray = SniTray {
            snapshot: *snapshots.borrow_and_update(),
            events: events.clone(),
            watcher,
        };
        let handle = match tokio::time::timeout(Duration::from_secs(3), tray.spawn()).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(error)) => {
                eprintln!("Falky system tray unavailable: {error}");
                return;
            }
            Err(_) => return,
        };
        let set_availability = |available| {
            let _ = events.send(Message(PlatformEvent::TrayAvailability(available)));
        };
        let mut available = false;

        // Test the host as well as the watcher. A watcher may still own its D-Bus
        // name after its host has gone away.
        let connection = tokio::time::timeout(Duration::from_secs(1), zbus::Connection::session())
            .await
            .ok()
            .and_then(Result::ok);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let online = tokio::select! {
                result = availability.changed() => {
                    if result.is_err() { break; }
                    let watching = *availability.borrow_and_update();
                    watching && host_active(connection.as_ref()).await
                }
                result = snapshots.changed() => {
                    if result.is_err() { break; }
                    let snapshot = *snapshots.borrow_and_update();
                    let update = handle.update(move |tray| tray.snapshot = snapshot);
                    if !matches!(tokio::time::timeout(Duration::from_secs(2), update).await, Ok(Some(()))) {
                        break;
                    }
                    continue;
                }
                _ = heartbeat.tick() => {
                    let watching = *availability.borrow();
                    watching && host_active(connection.as_ref()).await
                }
            };
            if available != online {
                available = online;
                set_availability(online);
            }
        }
        set_availability(false);
        let _ = tokio::time::timeout(Duration::from_secs(1), handle.shutdown()).await;
    }

    async fn host_active(connection: Option<&zbus::Connection>) -> bool {
        let Some(connection) = connection else {
            return false;
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
                .destination("org.kde.StatusNotifierWatcher")
                .path("/StatusNotifierWatcher")
                .interface("org.kde.StatusNotifierWatcher")
                .cache_properties(CacheProperties::No)
                .build()
                .await?;
            proxy
                .get_property::<bool>("IsStatusNotifierHostRegistered")
                .await
        })
        .await
        .is_ok_and(|result| result.unwrap_or(false))
    }

    struct SniTray {
        snapshot: Snapshot,
        events: Events,
        watcher: watch::Sender<bool>,
    }

    impl ksni::Tray for SniTray {
        fn id(&self) -> String {
            "falky".into()
        }

        fn title(&self) -> String {
            "Falky".into()
        }

        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let mut data = icon_rgba();
            for pixel in data.as_chunks_mut::<4>().0 {
                pixel.rotate_right(1);
            }
            vec![ksni::Icon {
                width: ICON_SIZE as i32,
                height: ICON_SIZE as i32,
                data,
            }]
        }

        fn activate(&mut self, _x: i32, _y: i32) {
            let _ = self
                .events
                .send(Message(PlatformEvent::TrayToggleVisibility));
        }

        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            self.snapshot
                .entries()
                .into_iter()
                .map(|(action, label, enabled)| {
                    StandardItem {
                        label: label.into(),
                        enabled,
                        activate: Box::new(move |tray: &mut Self| {
                            let _ = tray.events.send(Message(PlatformEvent::Tray(action)));
                        }),
                        ..Default::default()
                    }
                    .into()
                })
                .collect()
        }

        fn watcher_online(&self) {
            self.watcher.send_replace(true);
        }

        fn watcher_offline(&self, _reason: ksni::OfflineReason) -> bool {
            self.watcher.send_replace(false);
            true
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod os {
    use super::*;
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

    const TRAY_ID: &str = "falky";
    const ITEMS: [&str; 5] = [
        "falky-visibility",
        "falky-mute",
        "falky-deafen",
        "falky-leave",
        "falky-quit",
    ];

    pub(super) struct Service {
        _tray: TrayIcon,
        items: [MenuItem; 5],
    }

    impl Service {
        fn create(snapshot: Snapshot, events: Events) -> Result<Self, Box<dyn std::error::Error>> {
            let menu = Menu::new();
            let entries = snapshot.entries();
            let items = std::array::from_fn(|index| {
                let (_, label, enabled) = entries[index];
                MenuItem::with_id(ITEMS[index], label, enabled, None)
            });
            for item in &items {
                menu.append(item)?;
            }
            let mut builder = TrayIconBuilder::new()
                .with_id(TRAY_ID)
                .with_menu(Box::new(menu))
                .with_tooltip("Falky")
                .with_icon(Icon::from_rgba(icon_rgba(), ICON_SIZE, ICON_SIZE)?);
            if cfg!(target_os = "windows") {
                builder = builder.with_menu_on_left_click(false);
            }
            let tray = builder.build()?;
            #[cfg(target_os = "windows")]
            {
                use tray_icon::{MouseButton, MouseButtonState, TrayIconEvent};
                let icon_events = events.clone();
                TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
                    if event.id().as_ref() == TRAY_ID
                        && matches!(
                            event,
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            }
                        )
                    {
                        let _ = icon_events.send(Message(PlatformEvent::TrayToggleVisibility));
                    }
                }));
            }
            MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
                let action = match event.id().as_ref() {
                    id if id == ITEMS[0] => PlatformEvent::TrayToggleVisibility,
                    id if id == ITEMS[1] => PlatformEvent::Tray(TrayAction::ToggleMute),
                    id if id == ITEMS[2] => PlatformEvent::Tray(TrayAction::ToggleDeafen),
                    id if id == ITEMS[3] => PlatformEvent::Tray(TrayAction::LeaveVoice),
                    id if id == ITEMS[4] => PlatformEvent::Tray(TrayAction::Quit),
                    _ => return,
                };
                let _ = events.send(Message(action));
            }));
            Ok(Self { _tray: tray, items })
        }

        pub(super) fn sync(&self, snapshot: Snapshot) {
            for (item, (_, label, enabled)) in self.items.iter().zip(snapshot.entries()) {
                item.set_text(label);
                item.set_enabled(enabled);
            }
        }

        pub(super) fn shutdown(self) -> Task<Message> {
            drop(self);
            Task::none()
        }
    }

    pub(super) fn start(snapshot: Snapshot, events: Events) -> (Option<Service>, Task<Message>) {
        // AppKit and Win32 require creation and destruction on the iced UI thread.
        match Service::create(snapshot, events) {
            Ok(tray) => (
                Some(tray),
                Task::done(Message(PlatformEvent::TrayAvailability(true))),
            ),
            Err(error) => {
                eprintln!("Falky system tray unavailable: {error}");
                (None, Task::none())
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod os {
    use super::*;

    pub(super) struct Service;

    impl Service {
        pub(super) fn sync(&self, _snapshot: Snapshot) {}
        pub(super) fn shutdown(self) -> Task<Message> {
            Task::none()
        }
    }

    pub(super) fn start(_snapshot: Snapshot, _events: Events) -> (Option<Service>, Task<Message>) {
        (None, Task::none())
    }
}
