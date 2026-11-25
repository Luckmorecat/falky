use super::geometry::{Shape, blend, outer_radius, surface};
use super::icon::{Icon, icon};
use super::rooms::viewed;
use super::style::alpha;
use super::{ACTION_FONT, Action, HEADING_FONT, Modal, NUMBER_FONT, View, label, single_line};
use crate::ui_contract::{EffectiveTheme, PttAction, PttSource, ShellAction, VoiceAction};
use iced::widget::canvas::{self, Canvas, Geometry};
use iced::widget::{
    Row, Stack, button, center, column, container, mouse_area, opaque, row, slider, tooltip,
};
use iced::{Center, Color, Element, Event, Fill, Rectangle, Renderer, Theme, mouse, touch, window};

pub(super) fn press<'a, Message: 'a>(
    content: impl Into<Element<'a, Message>>,
    message: Option<Message>,
    rest: Color,
    hover: Color,
    radius: f32,
) -> button::Button<'a, Message> {
    button(content)
        .on_press_maybe(message)
        .style(move |_, status| button::Style {
            background: Some(
                match status {
                    button::Status::Hovered | button::Status::Pressed => hover,
                    _ => rest,
                }
                .into(),
            ),
            border: iced::border::rounded(radius * 0.72),
            ..Default::default()
        })
        .padding(0)
}

pub(super) fn icon_button<'a, Message: Clone + 'a>(
    symbol: Icon,
    title: impl iced::widget::text::IntoFragment<'a>,
    size: f32,
    ink: Color,
    background: Color,
    hover: Color,
    action: Option<Message>,
) -> Element<'a, Message> {
    let image = center(icon(symbol, (size * 0.55).min(22.0), ink))
        .width(size)
        .height(size);
    let hit = press(image, action, Color::TRANSPARENT, hover, size / 2.0)
        .width(size)
        .height(size);
    tooltip(
        surface(hit, size / 2.0, background),
        single_line(title, 13.0, ink),
        tooltip::Position::Top,
    )
    .style(|theme| container::Style {
        text_color: Some(theme.palette().text),
        background: Some(theme.extended_palette().background.weak.color.into()),
        border: iced::border::rounded(10.0),
        ..Default::default()
    })
    .into()
}

pub(super) struct Dock<'a, Message> {
    pub element: Element<'a, Message>,
    pub width: f32,
    pub chat_button_left: Option<f32>,
}

struct Controls<'a, Message> {
    row: Row<'a, Message>,
    width: f32,
    gap: f32,
    count: usize,
}

impl<'a, Message: 'a> Controls<'a, Message> {
    fn new(gap: f32) -> Self {
        Self {
            row: Row::new().align_y(Center).spacing(gap),
            width: 0.0,
            gap,
            count: 0,
        }
    }

    fn next_left(&self) -> f32 {
        self.width + if self.count == 0 { 0.0 } else { self.gap }
    }

    fn push(&mut self, control: impl Into<Element<'a, Message>>, width: f32) {
        self.width = self.next_left() + width;
        self.count += 1;
        let row = std::mem::replace(&mut self.row, Row::new());
        self.row = row.push(control);
    }
}

pub(super) fn view<'a, Message: Clone + 'a>(ctx: &View<'_, '_, Message>) -> Dock<'a, Message> {
    let c = ctx.color;
    let m = ctx.layout;
    let voice = ctx.input.voice;
    let room = viewed(ctx.input.rooms);
    let control = m.control_size;
    let face = blend(c.fill, c.raised);
    let interaction = c.fill_strong;
    let mut items = Controls::new(m.dock_gap);

    if voice.room.is_none() {
        if voice.joining.is_some() {
            let caption = ctx.copy.cancel();
            let width = text_width(caption, 36.0);
            let action = ctx.intent(ShellAction::Voice(VoiceAction::Leave));
            items.push(
                text_button(
                    label(caption, 15.0, c.text).font(ACTION_FONT),
                    width,
                    control,
                    face,
                    interaction,
                    action,
                ),
                width,
            );
        } else if let Some(room) = room {
            let caption = ctx.copy.join();
            let width = text_width(caption, 58.0);
            let content = row![
                icon(Icon::Mic, 22.0, c.on_invert),
                label(caption, 15.0, c.on_invert).font(ACTION_FONT)
            ]
            .align_y(Center)
            .spacing(8);
            let action = ctx.intent(ShellAction::Voice(VoiceAction::Join(room.id.clone())));
            items.push(
                text_button(
                    content,
                    width,
                    control,
                    c.invert,
                    Color::TRANSPARENT,
                    action,
                ),
                width,
            );
        }
    } else {
        if let Some(room) = room.filter(|room| voice.room.as_ref() != Some(&room.id)) {
            if !m.compact
                && let Some(call) = ctx
                    .input
                    .rooms
                    .iter()
                    .find(|item| Some(&item.id) == voice.room.as_ref())
            {
                let width = text_width(&call.name, 20.0).min(130.0);
                let text = container(single_line(call.name.clone(), 15.0, c.secondary))
                    .width(width)
                    .clip(true)
                    .center_y(control);
                let back = press(
                    text,
                    Some(ctx.intent(ShellAction::ViewRoom(call.id.clone()))),
                    Color::TRANSPARENT,
                    c.fill,
                    control / 2.0,
                );
                items.push(back, width);
            }
            let intent = voice
                .joining
                .is_none()
                .then(|| ctx.intent(ShellAction::Voice(VoiceAction::Join(room.id.clone()))));
            let caption = if voice.joining.is_some() {
                ctx.copy.joining()
            } else {
                ctx.copy.move_here()
            };
            if m.tiny {
                items.push(
                    icon_button(
                        Icon::Right,
                        caption,
                        control,
                        c.on_invert,
                        c.invert,
                        Color::TRANSPARENT,
                        intent,
                    ),
                    control,
                );
            } else {
                let width = text_width(caption, 30.0);
                let hit = press(
                    center(label(caption, 15.0, c.on_invert).font(ACTION_FONT))
                        .width(width)
                        .height(control),
                    intent,
                    Color::TRANSPARENT,
                    Color::TRANSPARENT,
                    control / 2.0,
                );
                items.push(surface(hit, control / 2.0, c.invert), width);
            }
            if !m.compact {
                items.push(separator(c.fill_strong), 1.0);
            }
        }

        let (deafen_icon, deafen_copy, deafen_ink) = if voice.deafened {
            (Icon::HeadOff, ctx.copy.undeafen(), c.secondary)
        } else {
            (Icon::Head, ctx.copy.deafen(), c.text)
        };
        items.push(
            icon_button(
                deafen_icon,
                deafen_copy,
                control,
                deafen_ink,
                face,
                interaction,
                Some(ctx.intent(ShellAction::Voice(VoiceAction::ToggleDeafen))),
            ),
            control,
        );
        items.push(microphone(ctx, control, face), control);
        if !m.compact {
            items.push(separator(c.fill_strong), 1.0);
        }
    }

    items.push(
        icon_button(
            Icon::Sliders,
            ctx.copy.settings(),
            control,
            c.text,
            face,
            interaction,
            Some(ctx.intent(ShellAction::OpenSettings)),
        ),
        control,
    );

    let mut chat_button_left = None;
    if let Some(room) = room {
        chat_button_left = Some(m.dock_pad + items.next_left());
        let (caption, ink, fill) = if ctx.input.chat_open {
            (ctx.copy.close_chat().to_owned(), c.on_invert, c.invert)
        } else if room.unread == 0 {
            (ctx.copy.chat().to_owned(), c.text, face)
        } else {
            (
                format!("{}: {}", ctx.copy.chat(), room.unread),
                c.text,
                face,
            )
        };
        let chat = icon_button(
            Icon::Chat,
            caption,
            control,
            ink,
            fill,
            if ctx.input.chat_open {
                Color::TRANSPARENT
            } else {
                interaction
            },
            Some(ctx.intent(ShellAction::ToggleChat)),
        );
        if room.unread > 0 && !ctx.input.chat_open {
            let count = if room.unread > 99 {
                "99+".to_owned()
            } else {
                room.unread.to_string()
            };
            let badge_width = (count.len() as f32 * 7.0 + 10.0).max(20.0);
            let badge = surface(
                center(label(count, 12.0, c.on_invert).font(NUMBER_FONT))
                    .width(badge_width)
                    .height(20),
                10.0,
                c.invert,
            );
            items.push(
                Stack::new()
                    .push(chat)
                    .push(container(badge).align_x(iced::Right).width(Fill)),
                control,
            );
        } else {
            items.push(chat, control);
        }
    }

    if voice.room.is_some() {
        let inner = control - if m.compact { 8.0 } else { 12.0 };
        let mark = surface(
            center(icon(Icon::X, 18.0, c.danger_background))
                .width(inner)
                .height(inner),
            inner / 2.0,
            c.danger,
        );
        let title = ctx.copy.leave();
        let (content, width): (Element<'a, Message>, f32) = if m.compact {
            (mark.into(), control)
        } else {
            let width = text_width(title, 72.0);
            (
                row![label(title, 15.0, c.danger), mark]
                    .spacing(10)
                    .align_y(Center)
                    .into(),
                width,
            )
        };
        let leave = text_button(
            content,
            width,
            control,
            c.danger_background,
            c.fill,
            ctx.action(Action::RequestLeave),
        );
        items.push(
            tooltip(
                leave,
                label(ctx.copy.leave_voice(), 13.0, c.text),
                tooltip::Position::Top,
            ),
            width,
        );
    }

    let body = container(items.row).padding(m.dock_pad);
    Dock {
        element: surface(body, outer_radius(control / 2.0, m.dock_pad), c.raised).into(),
        width: items.width + m.dock_pad * 2.0,
        chat_button_left,
    }
}

fn text_width(value: &str, padding: f32) -> f32 {
    value.chars().count() as f32 * 8.3 + padding
}

fn separator<'a, Message: 'a>(color: Color) -> Canvas<Shape, Message> {
    Canvas::new(Shape {
        fill: color,
        radius: 0.0,
    })
    .width(1)
    .height(28)
}

fn text_button<'a, Message: Clone + 'a>(
    content: impl Into<Element<'a, Message>>,
    width: f32,
    height: f32,
    background: Color,
    hover: Color,
    action: Message,
) -> Element<'a, Message> {
    let center = center(content).width(width).height(height);
    let hit = press(
        center,
        Some(action),
        Color::TRANSPARENT,
        hover,
        height / 2.0,
    );
    surface(hit, height / 2.0, background).into()
}

fn microphone<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    size: f32,
    rest: Color,
) -> Element<'a, Message> {
    let voice = ctx.input.voice;
    let c = ctx.color;
    let (symbol, message, foreground, background) = if voice.muted || voice.deafened {
        (Icon::MicOff, ctx.copy.unmute(), c.secondary, rest)
    } else {
        (Icon::Mic, ctx.copy.mute(), c.on_invert, c.invert)
    };
    let mic = if ctx.details.push_to_talk {
        let edge = |pressed| {
            ctx.intent(ShellAction::Voice(VoiceAction::PushToTalk(PttAction {
                source: PttSource::Dock,
                pressed,
            })))
        };
        let plate = center(icon(symbol, 22.0, foreground))
            .width(size)
            .height(size);
        let surface = surface(plate, size / 2.0, background);
        let enabled = !voice.deafened
            && !voice.listen_only
            && ctx.details.notice != Some(super::ConnectionNotice::ReconnectingVoice);
        let hit = Stack::new().push(surface).push(
            Canvas::new(Hold {
                down: edge(true),
                up: edge(false),
                enabled,
            })
            .width(size)
            .height(size),
        );
        tooltip(
            hit,
            label(ctx.copy.ptt(), 13.0, c.text),
            tooltip::Position::Top,
        )
        .into()
    } else {
        icon_button(
            symbol,
            message,
            size,
            foreground,
            background,
            c.fill,
            Some(ctx.intent(ShellAction::Voice(VoiceAction::ToggleMute))),
        )
    };

    let level = voice.mic_level.clamp(0.0, 1.0);
    let visible = level > 0.03 && !voice.muted && !voice.deafened;
    let ring_size = size * (1.06 + 0.12 * level);
    let ring = Canvas::new(Shape {
        fill: if visible {
            alpha(c.invert, 0.12 + level * 0.24)
        } else {
            Color::TRANSPARENT
        },
        radius: ring_size / 2.0,
    })
    .width(ring_size)
    .height(ring_size);
    // Keep the hold canvas in place when speech lights the meter ring.
    Stack::new()
        .push(mic)
        .push_under(center(ring).width(size).height(size))
        .into()
}

struct Hold<Message> {
    down: Message,
    up: Message,
    enabled: bool,
}

#[derive(Default, PartialEq)]
enum Held {
    #[default]
    None,
    Mouse,
    Touch(touch::Finger),
}

impl<Message: Clone> canvas::Program<Message> for Hold<Message> {
    type State = Held;

    fn update(
        &self,
        held: &mut Held,
        event: &Event,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> Option<canvas::Action<Message>> {
        let begin = match event {
            Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left))
                if cursor.is_over(bounds) =>
            {
                Some(Held::Mouse)
            }
            Event::Touch(touch::Event::FingerPressed { id, position })
                if bounds.contains(*position) =>
            {
                Some(Held::Touch(*id))
            }
            _ => None,
        };
        if self.enabled
            && *held == Held::None
            && let Some(input) = begin
        {
            *held = input;
            return Some(canvas::Action::publish(self.down.clone()).and_capture());
        }
        if *held == Held::None {
            return None;
        }
        let released = match event {
            Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left))
            | Event::Mouse(mouse::Event::CursorLeft) => *held == Held::Mouse,
            Event::Touch(
                touch::Event::FingerLifted { id, .. } | touch::Event::FingerLost { id, .. },
            ) => *held == Held::Touch(*id),
            Event::Window(window::Event::Unfocused) => true,
            _ => !self.enabled,
        };
        if released {
            *held = Held::None;
            return Some(canvas::Action::publish(self.up.clone()));
        }
        None
    }

    fn draw(
        &self,
        _: &Held,
        _: &Renderer,
        _: &Theme,
        _: Rectangle,
        _: mouse::Cursor,
    ) -> Vec<Geometry> {
        Vec::new()
    }

    fn mouse_interaction(
        &self,
        _: &Held,
        bounds: Rectangle,
        cursor: mouse::Cursor,
    ) -> mouse::Interaction {
        if self.enabled && cursor.is_over(bounds) {
            mouse::Interaction::Pointer
        } else {
            mouse::Interaction::None
        }
    }
}

pub(super) fn modal<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    emit: impl Fn(Action) -> Message + 'a,
) -> Option<Element<'a, Message>> {
    let c = ctx.color;
    let width = (ctx.layout.size.width - 32.0).clamp(1.0, 360.0);
    let actions_background = blend(c.fill, c.surface);
    let cancel = |width| {
        text_button(
            label(ctx.copy.cancel(), 15.0, c.text),
            width,
            42.0,
            actions_background,
            c.fill_strong,
            ctx.action(Action::Dismiss),
        )
    };
    let dialog: Element<'a, Message> = match ctx.state.modal.as_ref()? {
        Modal::Leave if ctx.input.voice.room.is_some() => {
            let yes = text_button(
                label(ctx.copy.leave(), 15.0, c.danger).font(ACTION_FONT),
                86.0,
                42.0,
                c.danger_background,
                c.fill,
                ctx.action(Action::ConfirmLeave),
            );
            column![
                label(ctx.copy.confirm_leave(), 20.0, c.text).font(HEADING_FONT),
                container(row![cancel(110.0), yes].spacing(8))
                    .align_x(iced::Right)
                    .width(Fill),
            ]
            .spacing(24)
            .into()
        }
        Modal::Gain(id) => {
            let person = ctx
                .input
                .stage
                .iter()
                .find(|p| &p.connection_id == id && !p.local)?;
            let active = viewed(ctx.input.rooms)
                .is_some_and(|room| Some(&room.id) == ctx.input.voice.room.as_ref());
            if !active {
                return None;
            }
            let title = format!("{} · {}", ctx.copy.volume(), person.name);
            let current = person.gain_percent.min(200);
            let gain = |percent| {
                ctx.intent(ShellAction::Voice(VoiceAction::SetGain {
                    connection_id: id.clone(),
                    percent,
                }))
            };
            let id = id.clone();
            let range = slider(0.0..=200.0, current as f32, move |raw| {
                emit(Action::Intent(ShellAction::Voice(VoiceAction::SetGain {
                    connection_id: id.clone(),
                    percent: settle_gain(raw),
                })))
            })
            .step(1.0_f32)
            .default(100.0_f32)
            .height(26);
            let title_percent = format!("{current}%");
            let lower = icon_button(
                Icon::Left,
                "−5%",
                40.0,
                c.text,
                actions_background,
                c.fill_strong,
                (current > 0).then(|| gain(current.saturating_sub(5))),
            );
            let higher = icon_button(
                Icon::Right,
                "+5%",
                40.0,
                c.text,
                actions_background,
                c.fill_strong,
                (current < 200).then(|| gain((current + 5).min(200))),
            );
            let reset = text_button(
                label("100%", 15.0, c.text).font(NUMBER_FONT),
                76.0,
                40.0,
                actions_background,
                c.fill_strong,
                gain(100),
            );
            column![
                label(title, 20.0, c.text).font(HEADING_FONT),
                container(label(title_percent, 16.0, c.text).font(NUMBER_FONT)).center_x(Fill),
                range,
                container(row![lower, reset, higher].spacing(8)).center_x(Fill),
            ]
            .spacing(12)
            .into()
        }
        _ => return None,
    };
    let dialog = opaque(surface(
        container(dialog).padding(24).width(width),
        32.0,
        c.surface,
    ));
    let shade = alpha(
        Color::BLACK,
        if ctx.input.theme == EffectiveTheme::Light {
            0.32
        } else {
            0.55
        },
    );
    let backdrop = container(iced::widget::Space::new())
        .width(Fill)
        .height(Fill)
        .style(move |_| container::Style {
            background: Some(shade.into()),
            ..Default::default()
        });
    Some(
        Stack::new()
            .push(mouse_area(backdrop).on_press(ctx.action(Action::Dismiss)))
            .push(center(dialog))
            .width(Fill)
            .height(Fill)
            .into(),
    )
}

fn settle_gain(raw: f32) -> u16 {
    if (raw - 100.0).abs() < 6.0 {
        100
    } else {
        (raw.clamp(0.0, 200.0) / 5.0).round() as u16 * 5
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_contract::{Language, ShellInput, Viewport, VoiceStatus};
    use iced::advanced::widget::{Tree, tree};
    use iced::widget::canvas::Program;

    #[test]
    fn dock_releases_a_hold_after_the_live_meter_changes_the_microphone() {
        let state = super::super::State::default();
        let mic = |voice: &VoiceStatus| {
            let input = ShellInput {
                theme: EffectiveTheme::Dark,
                language: Language::En,
                rooms: &[],
                stage: &[],
                voice,
                ticker: &[],
                chat_open: false,
                viewport: Viewport::default(),
            };
            microphone(
                &View {
                    state: &state,
                    input,
                    details: super::super::Details {
                        push_to_talk: true,
                        ..Default::default()
                    },
                    layout: super::super::Layout::new(input.viewport, false),
                    color: super::super::Colors::new(input.theme),
                    copy: super::super::CopyText::new(input.language),
                    emit: &|action| {
                        let Action::Intent(ShellAction::Voice(VoiceAction::PushToTalk(edge))) =
                            action
                        else {
                            panic!("expected dock hold action");
                        };
                        edge.pressed
                    },
                },
                40.0,
                Color::BLACK,
            )
        };
        fn hold_state(tree: &mut Tree) -> Option<&mut Held> {
            if let tree::State::Some(state) = &mut tree.state
                && state.is::<Held>()
            {
                return state.downcast_mut();
            }
            tree.children.iter_mut().find_map(hold_state)
        }

        let voice = VoiceStatus {
            room: Some("voice-room".into()),
            muted: true,
            ..VoiceStatus::default()
        };
        let mut tree = Tree::new(mic(&voice).as_widget());
        let hold = Hold {
            down: true,
            up: false,
            enabled: true,
        };
        let bounds = Rectangle::with_size(iced::Size::new(40.0, 40.0));
        let pressed = hold
            .update(
                hold_state(&mut tree).unwrap(),
                &Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
                bounds,
                mouse::Cursor::Available(iced::Point::new(10.0, 10.0)),
            )
            .unwrap();
        assert_eq!(pressed.into_inner().0, Some(true));

        let speaking = VoiceStatus {
            muted: false,
            mic_level: 0.5,
            ..voice
        };
        tree.diff(mic(&speaking).as_widget());
        let released = hold
            .update(
                hold_state(&mut tree).unwrap(),
                &Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)),
                bounds,
                mouse::Cursor::Unavailable,
            )
            .unwrap();
        assert_eq!(released.into_inner().0, Some(false));
    }

    #[test]
    fn pointer_volume_uses_five_percent_steps_and_a_unity_detent() {
        let cases = [
            (-1.0, 0),
            (3.0, 5),
            (94.0, 95),
            (95.0, 100),
            (105.0, 100),
            (106.0, 105),
            (134.0, 135),
            (206.0, 200),
        ];
        for (raw, expected) in cases {
            assert_eq!(settle_gain(raw), expected);
        }
    }

    #[test]
    fn push_to_talk_releases_after_pointer_leaves_and_window_loses_focus() {
        let hold = Hold {
            down: true,
            up: false,
            enabled: true,
        };
        let bounds = Rectangle {
            x: 0.0,
            y: 0.0,
            width: 40.0,
            height: 40.0,
        };
        let mut held = Held::None;
        let cursor = mouse::Cursor::Available(iced::Point::new(10.0, 10.0));
        assert!(
            hold.update(
                &mut held,
                &Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left)),
                bounds,
                cursor
            )
            .is_some()
        );
        assert!(held == Held::Mouse);
        assert!(
            hold.update(
                &mut held,
                &Event::Window(window::Event::Unfocused),
                bounds,
                mouse::Cursor::Unavailable
            )
            .is_some()
        );
        assert!(held == Held::None);
        assert!(
            hold.update(
                &mut held,
                &Event::Mouse(mouse::Event::ButtonReleased(mouse::Button::Left)),
                bounds,
                mouse::Cursor::Unavailable
            )
            .is_none()
        );
    }
}
