use std::sync::Arc;

use falky_core::model::ConnectionId;
use iced::advanced::{
    Clipboard, Layout, Shell, Widget, layout, renderer, widget::Tree, widget::tree,
};
use iced::widget::{
    Column, Row, Stack, center, container, mouse_area, row, scrollable, slider, space,
};
use iced::{
    Bottom, Center, Color, Element, Event, Fill, Length, Rectangle, Renderer, Size, Theme, Vector,
    mouse, touch,
};

use crate::locale::{self, Key};
use crate::ui_contract::StageParticipant;

use super::controls::{icon_button, press, settle_gain};
use super::geometry::{outer_radius, surface};
use super::icon::Icon;
use super::share_video::{self, PlanarFrame, contained};
use super::style::Colors;
use super::{Action, NUMBER_FONT, View, label, single_line};

const BAR_PADDING: f32 = 8.0;
const BAR_GAP: f32 = 6.0;
const BUTTON_SIZE: f32 = 36.0;
const VOLUME_HEIGHT: f32 = 30.0;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShareAction {
    ToggleCapture,
    Watch(ConnectionId),
    StopWatching,
    Volume(u16),
    ToggleVolumeMute,
    ToggleFullscreen,
    PointerMoved,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ShareCaptureStatus {
    #[default]
    Hidden,
    Idle,
    Starting,
    Sharing,
    Stopping,
}

#[derive(Clone, Debug)]
pub struct ShareView<'a> {
    pub selected: Option<&'a ConnectionId>,
    pub frame: Option<Arc<dyn PlanarFrame>>,
    pub volume: u16,
    pub capture: ShareCaptureStatus,
}

impl Default for ShareView<'_> {
    fn default() -> Self {
        Self {
            selected: None,
            frame: None,
            volume: 100,
            capture: ShareCaptureStatus::default(),
        }
    }
}

pub(super) fn inline<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    person: &StageParticipant,
    size: Size,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let bar_height = BUTTON_SIZE
        + BAR_PADDING * 2.0
        + if person.local {
            0.0
        } else {
            BAR_GAP + VOLUME_HEIGHT
        };
    let video_size = Size::new(size.width, (size.height - bar_height).max(1.0));
    Column::new()
        .push(picture(ctx, video_size))
        .push(bar(ctx, person, size.width, emit))
        .width(size.width)
        .height(size.height)
        .into()
}

pub(super) fn fullscreen<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    person: &StageParticipant,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let size = ctx.layout.size;
    let mut stack = Stack::new()
        .push(picture(ctx, size))
        .width(Fill)
        .height(Fill);
    if ctx.state.share_controls_visible() {
        let controls = bar(
            ctx,
            person,
            (size.width - BAR_PADDING * 2.0).clamp(1.0, 780.0),
            emit,
        );
        stack = stack.push(
            container(controls)
                .align_x(Center)
                .align_y(Bottom)
                .width(Fill)
                .height(Fill)
                .padding(BAR_PADDING),
        );
    }
    stack.into()
}

fn picture<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    size: Size,
) -> Element<'a, Message> {
    let content: Element<'a, Message> = if let Some(frame) = ctx.share.frame.as_ref() {
        let fitted = contained(size, frame.dimensions());
        share_video::widget(frame, fitted)
    } else {
        single_line(
            locale::text(ctx.input.language, Key::ShareWaiting),
            15.0,
            Color::WHITE,
        )
        .into()
    };
    let backdrop = center::<Message, _, _>(content)
        .width(size.width)
        .height(size.height)
        .style(|_| container::Style::default().background(Color::BLACK));
    mouse_area(backdrop)
        .on_double_click(ctx.action(Action::Share(ShareAction::ToggleFullscreen)))
        .into()
}

fn bar<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    person: &StageParticipant,
    width: f32,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let colors = ctx.color;
    let language = ctx.input.language;
    let t = |key| locale::text(language, key);
    let into_fullscreen = !ctx.state.share_fullscreen();
    let text = if into_fullscreen {
        Key::Fullscreen
    } else {
        Key::ExitFullscreen
    };
    let fullscreen = icon_button(
        if into_fullscreen {
            Icon::Expand
        } else {
            Icon::Collapse
        },
        t(text),
        BUTTON_SIZE,
        colors.text,
        colors.raised,
        colors.raised_hover,
        Some(ctx.action(Action::Share(ShareAction::ToggleFullscreen))),
    );
    let stop_action = ctx.action(Action::Share(ShareAction::StopWatching));
    let stop = if width < 470.0 {
        icon_button(
            Icon::X,
            t(Key::StopWatching),
            BUTTON_SIZE,
            colors.text,
            colors.raised,
            colors.raised_hover,
            Some(stop_action),
        )
    } else {
        let caption = container(single_line(t(Key::StopWatching), 14.0, colors.text))
            .center_y(BUTTON_SIZE)
            .padding([0, 12]);
        toolbar_button(caption, stop_action, colors.raised, colors.raised_hover)
    };

    let mut tabs = Row::new().spacing(BAR_GAP);
    for sharer in ctx
        .input
        .stage
        .iter()
        .filter(|candidate| candidate.screen_share)
    {
        let name = if sharer.local {
            t(Key::YourScreen).to_owned()
        } else {
            locale::screen_of(language, &sharer.name)
        };
        let selected = person.connection_id == sharer.connection_id;
        let (ink, fill, hover) = if selected {
            (colors.on_invert, colors.invert, colors.invert)
        } else {
            (colors.text, colors.raised, colors.raised_hover)
        };
        let title = container(single_line(name, 14.0, ink))
            .center_y(BUTTON_SIZE - 2.0)
            .max_width(220)
            .clip(true)
            .padding([0, 12]);
        tabs = tabs.push(toolbar_button(
            title,
            ctx.action(Action::Share(ShareAction::Watch(
                sharer.connection_id.clone(),
            ))),
            fill,
            hover,
        ));
    }
    let tabs = scrollable(tabs)
        .direction(scrollable::Direction::Horizontal(
            scrollable::Scrollbar::new().width(3).scroller_width(3),
        ))
        .width(Fill);
    let mut controls = Column::new().push(
        row![tabs, fullscreen, stop]
            .spacing(BAR_GAP)
            .align_y(Center),
    );
    if !person.local {
        controls = controls.push(volume(ctx, emit));
    }
    container(controls.spacing(BAR_GAP))
        .width(width)
        .padding(BAR_PADDING)
        .style(move |_| {
            container::Style::default()
                .background(colors.surface)
                .border(iced::border::rounded(outer_radius(
                    BUTTON_SIZE / 2.0,
                    BAR_PADDING,
                )))
        })
        .into()
}

fn toolbar_button<'a, Message: Clone + 'a>(
    content: impl Into<Element<'a, Message>>,
    action: Message,
    fill: Color,
    hover: Color,
) -> Element<'a, Message> {
    let radius = BUTTON_SIZE / 2.0;
    surface(
        press(content, Some(action), Color::TRANSPARENT, hover, radius),
        radius,
        fill,
    )
    .into()
}

fn volume<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let Colors {
        text,
        raised,
        raised_hover,
        ..
    } = ctx.color;
    let language = ctx.input.language;
    let value = ctx.share.volume;
    let muted = value == 0;
    let mute = icon_button(
        if muted {
            Icon::SpeakerOff
        } else {
            Icon::Speaker
        },
        locale::text(
            language,
            if muted {
                Key::ShareUnmute
            } else {
                Key::ShareMute
            },
        ),
        VOLUME_HEIGHT,
        text,
        raised,
        raised_hover,
        Some(ctx.action(Action::Share(ShareAction::ToggleVolumeMute))),
    );
    let scale = volume_scale(value, emit);
    let name = locale::text(language, Key::ShareVolume);
    let caption: Element<'a, Message> = if ctx.layout.tiny {
        space().into()
    } else {
        single_line(name, 13.0, text).into()
    };
    let range = iced::widget::tooltip(
        scale,
        single_line(name, 13.0, text),
        iced::widget::tooltip::Position::Top,
    );
    row![
        caption,
        mute,
        container(range).max_width(220),
        container(label(format!("{value}%"), 14.0, text).font(NUMBER_FONT)).width(44),
    ]
    .spacing(BAR_GAP)
    .align_y(Center)
    .into()
}

fn volume_scale<'a, Message: Clone + 'a>(
    value: u16,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    Element::new(VolumeScale {
        slider: slider(0..=200, value, move |percent| {
            emit(Action::Share(ShareAction::Volume(percent)))
        })
        .step(5_u16)
        .default(100_u16)
        .height(VOLUME_HEIGHT)
        .into(),
    })
}

struct VolumeScale<'a, Message> {
    slider: Element<'a, Message>,
}

impl<Message> Widget<Message, Theme, Renderer> for VolumeScale<'_, Message> {
    fn tag(&self) -> tree::Tag {
        self.slider.as_widget().tag()
    }

    fn state(&self) -> tree::State {
        self.slider.as_widget().state()
    }

    fn size(&self) -> Size<Length> {
        self.slider.as_widget().size()
    }

    fn layout(
        &mut self,
        tree: &mut Tree,
        renderer: &Renderer,
        limits: &layout::Limits,
    ) -> layout::Node {
        self.slider.as_widget_mut().layout(tree, renderer, limits)
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        theme: &Theme,
        style: &renderer::Style,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        self.slider
            .as_widget()
            .draw(tree, renderer, theme, style, layout, cursor, viewport);
    }

    fn mouse_interaction(
        &self,
        tree: &Tree,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        viewport: &Rectangle,
        renderer: &Renderer,
    ) -> mouse::Interaction {
        self.slider
            .as_widget()
            .mouse_interaction(tree, layout, cursor, viewport, renderer)
    }

    fn update(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        layout: Layout<'_>,
        cursor: mouse::Cursor,
        renderer: &Renderer,
        clipboard: &mut dyn Clipboard,
        shell: &mut Shell<'_, Message>,
        viewport: &Rectangle,
    ) {
        let pointer = matches!(
            event,
            Event::Mouse(
                mouse::Event::ButtonPressed(mouse::Button::Left) | mouse::Event::CursorMoved { .. }
            ) | Event::Touch(touch::Event::FingerPressed { .. } | touch::Event::FingerMoved { .. })
        );
        let cursor = if pointer {
            snap_unity(cursor, layout.bounds())
        } else {
            cursor
        };
        self.slider.as_widget_mut().update(
            tree, event, layout, cursor, renderer, clipboard, shell, viewport,
        );
    }
}

fn snap_unity(cursor: mouse::Cursor, bounds: Rectangle) -> mouse::Cursor {
    // Iced advances its current slider value across queued events before rebuilding the view.
    let Some(position) = cursor.land().position().filter(|_| bounds.width > 0.0) else {
        return cursor;
    };
    let fraction = f64::from(position.x - bounds.x) / f64::from(bounds.width);
    let percent = (200.0 * fraction).round() as f32;
    if settle_gain(percent) == 100 {
        cursor + Vector::new(bounds.x + bounds.width / 2.0 - position.x, 0.0)
    } else {
        cursor
    }
}

#[cfg(test)]
mod tests {
    use iced::advanced::{clipboard, renderer::Headless};
    use iced::{Font, Pixels, Point, keyboard};

    use super::*;

    #[tokio::test]
    async fn volume_wheel_steps_across_unity_in_both_directions() {
        let gestures = std::iter::once(Event::Keyboard(keyboard::Event::ModifiersChanged(
            keyboard::Modifiers::CTRL,
        )))
        .chain([1.0, 1.0, -1.0, -1.0].map(wheel))
        .map(|event| (event, 100.0));
        assert_eq!(volume_changes(95, gestures).await, [100, 105, 100, 95]);
    }

    #[tokio::test]
    async fn volume_pointer_snaps_to_unity_across_a_wider_band() {
        let down = Event::Mouse(mouse::Event::ButtonPressed(mouse::Button::Left));
        let moved = |x| {
            (
                Event::Mouse(mouse::Event::CursorMoved {
                    position: Point::new(x, 15.0),
                }),
                x,
            )
        };
        let gestures = [(down, 93.0), moved(95.0), moved(105.0), moved(107.0)];
        assert_eq!(volume_changes(100, gestures).await, [95, 100, 105]);
    }

    #[tokio::test]
    async fn volume_pointer_and_wheel_share_the_latest_snap_without_rebuilding() {
        let button = mouse::Button::Left;
        let gestures = [
            (Event::Mouse(mouse::Event::ButtonPressed(button)), 96.0),
            (Event::Mouse(mouse::Event::ButtonReleased(button)), 96.0),
            (
                Event::Keyboard(keyboard::Event::ModifiersChanged(keyboard::Modifiers::CTRL)),
                96.0,
            ),
            (wheel(1.0), 96.0),
        ];
        assert_eq!(volume_changes(95, gestures).await, [100, 105]);
    }

    fn wheel(y: f32) -> Event {
        Event::Mouse(mouse::Event::WheelScrolled {
            delta: mouse::ScrollDelta::Lines { x: 0.0, y },
        })
    }

    async fn volume_changes(
        initial: u16,
        gestures: impl IntoIterator<Item = (Event, f32)>,
    ) -> Vec<u16> {
        let renderer = Renderer::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .unwrap();
        let mut scale = volume_scale(initial, std::convert::identity);
        let mut tree = Tree::new(scale.as_widget());
        let size = Size::new(200.0, VOLUME_HEIGHT);
        let layout = scale.as_widget_mut().layout(
            &mut tree,
            &renderer,
            &layout::Limits::new(Size::ZERO, size),
        );
        let mut messages = Vec::new();
        for (event, x) in gestures {
            let cursor = mouse::Cursor::Available(Point::new(x, VOLUME_HEIGHT / 2.0));
            scale.as_widget_mut().update(
                &mut tree,
                &event,
                Layout::new(&layout),
                cursor,
                &renderer,
                &mut clipboard::Null,
                &mut Shell::new(&mut messages),
                &Rectangle::with_size(size),
            );
        }
        messages
            .into_iter()
            .map(|message| {
                let Action::Share(ShareAction::Volume(percent)) = message else {
                    panic!("expected share volume")
                };
                percent
            })
            .collect()
    }
}
