//! The desktop room surface and the web-default rendering primitives.

mod controls;
mod copy;
pub mod geometry;
pub mod icon;
pub mod layout;
mod orb;
mod rooms;
mod share;
mod share_video;
mod stage;
pub mod style;
mod ticker;

pub use share::{ShareAction, ShareCaptureStatus, ShareView};
pub use share_video::{PlanarFrame, Plane};
pub use style::theme;

use crate::ui_contract::{ShellAction, ShellInput};
use falky_core::model::{ConnectionId, PaletteName, RoomId};
use iced::font::Weight;
use iced::time::{self, Instant};
use iced::widget::{Canvas, Stack, container, text};
use iced::{Color, Element, Event, Fill, Font, Rectangle, Subscription, event, mouse};
use std::time::Duration;

use self::copy::CopyText;
use self::geometry::DotGrid;
use self::layout::Layout;
use self::style::Colors;

pub const ONEST: &[u8] = include_bytes!("../../assets/Onest.ttf");
pub const ONEST_NATIVE: &[u8] = include_bytes!("../../assets/Onest-Native.ttc");
pub const REACTIONS: &[u8] = include_bytes!("../../assets/FalkyReactions.ttf");
pub const DEFAULT_FONT: Font = Font::with_name("Falky Onest Text");
pub const NUMBER_FONT: Font = Font::with_name("Falky Onest Numbers");
pub const HEADING_FONT: Font = Font {
    weight: Weight::Medium,
    ..Font::with_name("Onest")
};
pub const ACTION_FONT: Font = Font {
    weight: Weight::Semibold,
    ..Font::with_name("Onest")
};
pub const REACTION_FONT: Font = Font::with_name("Falky Reactions");

#[derive(Clone, Copy, Debug)]
pub struct RoomPeople<'a> {
    pub room: &'a RoomId,
    pub names: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct TickerSender<'a> {
    pub identity: &'a str,
    pub palette: Option<PaletteName>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectionNotice {
    Reconnecting,
    ReconnectingVoice,
}

/// Optional presentation data supplied by the app alongside the shared input.
#[derive(Clone, Copy, Debug)]
pub struct Details<'a> {
    pub push_to_talk: bool,
    pub motion: bool,
    pub joined_at: Option<Instant>,
    pub notice: Option<ConnectionNotice>,
    pub room_people: &'a [RoomPeople<'a>],
    /// In the same order as `ShellInput::ticker`.
    pub ticker_senders: &'a [TickerSender<'a>],
}

impl Default for Details<'_> {
    fn default() -> Self {
        Self {
            push_to_talk: false,
            motion: true,
            joined_at: None,
            notice: None,
            room_people: &[],
            ticker_senders: &[],
        }
    }
}

#[derive(Clone, Debug)]
pub enum Action {
    Intent(ShellAction),
    Share(ShareAction),
    RoomsHovered(bool),
    ToggleRooms,
    CloseRooms,
    OpenGain(ConnectionId),
    RequestLeave,
    ConfirmLeave,
    Dismiss,
    Frame(Instant),
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Modal {
    Leave,
    Gain(ConnectionId),
}

#[derive(Debug)]
pub struct State {
    began: Instant,
    now: Instant,
    rooms_open: bool,
    close_rooms_at: Option<Instant>,
    modal: Option<Modal>,
    share_fullscreen: bool,
    share_controls_until: Instant,
}

impl Default for State {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            began: now,
            now,
            rooms_open: false,
            close_rooms_at: None,
            modal: None,
            share_fullscreen: false,
            share_controls_until: now,
        }
    }
}

impl State {
    pub fn update(&mut self, action: Action) {
        match action {
            Action::Intent(_) => {}
            Action::Share(action) => match action {
                ShareAction::ToggleFullscreen => {
                    self.share_fullscreen = !self.share_fullscreen;
                    self.show_share_controls();
                }
                ShareAction::PointerMoved => self.show_share_controls(),
                _ => {}
            },
            Action::RoomsHovered(true) => {
                self.close_rooms_at = None;
                self.rooms_open = true;
            }
            Action::RoomsHovered(false) => {
                self.close_rooms_at = Some(Instant::now() + Duration::from_millis(220));
            }
            Action::ToggleRooms => {
                self.close_rooms_at = None;
                self.rooms_open = !self.rooms_open;
            }
            Action::CloseRooms => {
                self.close_rooms_at = None;
                self.rooms_open = false;
            }
            Action::OpenGain(id) => self.modal = Some(Modal::Gain(id)),
            Action::RequestLeave => self.modal = Some(Modal::Leave),
            Action::ConfirmLeave | Action::Dismiss => self.modal = None,
            Action::Frame(now) => {
                self.now = now.max(self.now);
                if self.close_rooms_at.is_some_and(|at| self.now >= at) {
                    self.rooms_open = false;
                    self.close_rooms_at = None;
                }
            }
        }
    }

    pub fn room_strip_open(&self) -> bool {
        self.rooms_open
    }

    pub fn modal_open(&self) -> bool {
        self.modal.is_some()
    }

    pub fn share_fullscreen(&self) -> bool {
        self.share_fullscreen
    }

    pub fn exit_share_fullscreen(&mut self) -> bool {
        std::mem::take(&mut self.share_fullscreen)
    }

    fn show_share_controls(&mut self) {
        self.share_controls_until = Instant::now().max(self.now) + Duration::from_secs(3);
    }

    fn share_controls_visible(&self) -> bool {
        !self.share_fullscreen || self.now < self.share_controls_until
    }

    pub fn reconcile(
        &mut self,
        viewed: Option<&RoomId>,
        voice: Option<&RoomId>,
        remote_present: impl FnOnce(&ConnectionId) -> bool,
    ) {
        let stale = match self.modal.as_ref() {
            Some(Modal::Leave) => voice.is_none(),
            Some(Modal::Gain(id)) => voice.is_none() || viewed != voice || !remote_present(id),
            None => false,
        };
        if stale {
            self.modal = None;
        }
    }

    pub fn subscription(&self, input: ShellInput<'_>) -> Subscription<Action> {
        self.subscription_with_motion(input, true)
    }

    pub fn subscription_with_motion(
        &self,
        input: ShellInput<'_>,
        motion: bool,
    ) -> Subscription<Action> {
        self.subscription_with_share(input, motion, false)
    }

    pub fn subscription_with_share(
        &self,
        input: ShellInput<'_>,
        motion: bool,
        watching: bool,
    ) -> Subscription<Action> {
        let microphone_active = input.voice.room.is_some()
            && !input.voice.muted
            && !input.voice.deafened
            && input.voice.mic_level > 0.03;
        let lively = input.stage.iter().any(stage::active) || microphone_active;
        let interval = if lively || watching {
            Some(Duration::from_millis(17))
        } else if self.close_rooms_at.is_some() || (motion && !input.stage.is_empty()) {
            Some(Duration::from_millis(67))
        } else if input.voice.room.is_some() {
            Some(Duration::from_millis(500))
        } else {
            None
        };
        let frame = interval.map_or_else(Subscription::none, |interval| {
            time::every(interval).map(Action::Frame)
        });
        if self.share_fullscreen && watching {
            Subscription::batch([
                frame,
                event::listen_with(|event, _, _| {
                    matches!(event, Event::Mouse(mouse::Event::CursorMoved { .. }))
                        .then_some(Action::Share(ShareAction::PointerMoved))
                }),
            ])
        } else {
            frame
        }
    }

    fn seconds(&self) -> f32 {
        self.now.duration_since(self.began).as_secs_f32()
    }
}

struct View<'a, 'm, Message> {
    state: &'a State,
    input: ShellInput<'a>,
    details: Details<'a>,
    share: ShareView<'a>,
    layout: Layout,
    color: Colors,
    copy: CopyText,
    emit: &'m dyn Fn(Action) -> Message,
}

impl<Message> View<'_, '_, Message> {
    fn action(&self, action: Action) -> Message {
        (self.emit)(action)
    }

    fn intent(&self, action: ShellAction) -> Message {
        self.action(Action::Intent(action))
    }
}

pub fn view<'a, Message: Clone + 'a>(
    state: &State,
    input: ShellInput<'_>,
    details: Details<'_>,
    chat: Option<Element<'a, Message>>,
    on_action: impl Fn(Action) -> Message + Clone + 'a,
) -> Element<'a, Message> {
    view_with_share(state, input, details, ShareView::default(), chat, on_action)
}

pub fn view_with_share<'a, Message: Clone + 'a>(
    state: &State,
    input: ShellInput<'_>,
    details: Details<'_>,
    share: ShareView<'_>,
    chat: Option<Element<'a, Message>>,
    on_action: impl Fn(Action) -> Message + Clone + 'a,
) -> Element<'a, Message> {
    let context = View {
        state,
        input,
        details,
        share,
        layout: Layout::new(input.viewport, state.rooms_open),
        color: Colors::new(input.theme),
        copy: CopyText::new(input.language),
        emit: &on_action,
    };
    let layout = context.layout;
    let watched = stage::watched(&context);
    if state.share_fullscreen()
        && let Some(person) = watched
    {
        return share::fullscreen(&context, person, on_action.clone());
    }
    let mut layers = Stack::new()
        .push(
            Canvas::new(DotGrid {
                background: context.color.background,
                dot: context.color.dot,
            })
            .width(Fill)
            .height(Fill),
        )
        .push(stage::view(&context, watched, on_action.clone()))
        .push(rooms::view(&context));
    let dock = controls::view(&context);
    let dock_left = ((layout.size.width - dock.width) / 2.0).max(0.0);
    let chat_button_left = dock_left + dock.chat_button_left.unwrap_or(dock.width / 2.0);
    layers = layers.push(at(
        dock.element,
        Rectangle {
            x: dock_left,
            y: layout.dock_top().max(0.0),
            width: dock.width,
            height: layout.control_size + layout.dock_pad * 2.0,
        },
    ));

    if input.chat_open {
        if let Some(card) = chat {
            layers = layers.push(at(card, layout.chat(chat_button_left)));
        }
    } else if !input.ticker.is_empty() {
        layers = layers.push(ticker::view(&context, dock_left + dock.width));
    }

    if let Some(notice) = rooms::notice(&context) {
        layers = layers.push(notice);
    }
    if let Some(modal) = controls::modal(&context, on_action.clone()) {
        layers = layers.push(modal);
    }

    layers.width(Fill).height(Fill).clip(true).into()
}

fn at<'a, Message: 'a>(
    content: impl Into<Element<'a, Message>>,
    bounds: Rectangle,
) -> Element<'a, Message> {
    container(container(content).width(bounds.width).height(bounds.height))
        .padding(iced::Padding {
            top: bounds.y,
            left: bounds.x,
            ..Default::default()
        })
        .into()
}

fn label<'a>(
    value: impl iced::widget::text::IntoFragment<'a>,
    size: f32,
    color: Color,
) -> iced::widget::Text<'a> {
    text(value)
        .size(size)
        .color(color)
        .shaping(iced::widget::text::Shaping::Advanced)
}

fn single_line<'a>(
    value: impl iced::widget::text::IntoFragment<'a>,
    size: f32,
    color: Color,
) -> iced::widget::Text<'a> {
    label(value, size, color).wrapping(iced::widget::text::Wrapping::None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconciles_dialogs_with_the_visible_voice_room_and_participants() {
        let mut state = State::default();
        let room: RoomId = "voice".into();
        let other: RoomId = "other".into();
        let target: ConnectionId = "person.connection".into();

        state.update(Action::OpenGain(target.clone()));
        state.reconcile(Some(&room), Some(&room), |id| id == &target);
        assert!(state.modal_open());
        state.reconcile(Some(&other), Some(&room), |_| true);
        assert!(!state.modal_open());

        state.update(Action::OpenGain(target));
        state.reconcile(Some(&room), Some(&room), |_| false);
        assert!(!state.modal_open());

        state.update(Action::RequestLeave);
        state.reconcile(Some(&other), Some(&room), |_| false);
        assert!(state.modal_open());
        state.reconcile(Some(&other), None, |_| false);
        assert!(!state.modal_open());
    }

    #[test]
    fn fullscreen_share_controls_hide_and_return_without_dismissing_the_share() {
        let mut state = State::default();
        state.update(Action::Share(ShareAction::ToggleFullscreen));
        assert!(state.share_fullscreen());
        assert!(state.share_controls_visible());

        state.update(Action::Frame(state.share_controls_until));
        assert!(!state.share_controls_visible());

        state.update(Action::Share(ShareAction::PointerMoved));
        assert!(state.share_controls_visible());
        assert!(state.exit_share_fullscreen());
        assert!(state.share_controls_visible());
        assert!(!state.exit_share_fullscreen());

        state.update(Action::Share(ShareAction::ToggleFullscreen));
        state.update(Action::Share(ShareAction::StopWatching));
        assert!(state.share_fullscreen());
        assert!(state.exit_share_fullscreen());
        assert!(!state.share_fullscreen());
    }
}
