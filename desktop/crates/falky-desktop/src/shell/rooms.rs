use super::geometry::{Shape, surface};
use super::icon::{Icon, icon};
use super::orb::{Orb, Slot};
use super::style;
use super::{Action, ConnectionNotice, HEADING_FONT, NUMBER_FONT, View, at, label, single_line};
use crate::ui_contract::{RoomIndicator, ShellAction};
use iced::widget::{
    Canvas, Row, center, column, container, mouse_area, row, scrollable, shader, tooltip,
};
use iced::{Color, Element, Fill, Rectangle};
use std::f32::consts::PI;

pub(super) fn viewed(rooms: &[RoomIndicator]) -> Option<&RoomIndicator> {
    rooms.iter().find(|room| room.viewed)
}

pub(super) fn view<'a, Message: Clone + 'a>(ctx: &View<'_, '_, Message>) -> Element<'a, Message> {
    let current = viewed(ctx.input.rooms);
    let compact = ctx.layout.compact;
    let c = ctx.color;
    let title = current.map_or_else(|| ctx.copy.no_rooms().to_owned(), |room| room.name.clone());
    let title_size = if compact { 22.0 } else { 28.0 };
    let title_max = (ctx.layout.size.width - 72.0).clamp(30.0, 490.0);
    let mut headline = row![
        container(single_line(title, title_size, c.text).font(HEADING_FONT))
            .max_width(title_max)
            .clip(true)
    ]
    .align_y(iced::Center)
    .spacing(6);
    if !ctx.input.rooms.is_empty() {
        let arrow = icon(Icon::Chevron, 18.0, c.secondary)
            .rotation(iced::Radians(if ctx.state.rooms_open { PI } else { 0.0 }));
        headline = headline.push(surface(center(arrow).width(26).height(26), 13.0, c.fill));
    }
    if ctx
        .input
        .rooms
        .iter()
        .any(|room| !room.viewed && room.unread > 0)
    {
        headline = headline.push(tooltip(
            dot(c.invert),
            label(ctx.copy.new_messages(), 13.0, c.text),
            tooltip::Position::Bottom,
        ));
    }

    let title = super::controls::press(
        headline,
        if ctx.input.rooms.is_empty() {
            None
        } else {
            Some(ctx.action(Action::ToggleRooms))
        },
        Color::TRANSPARENT,
        c.fill,
        20.0,
    )
    .padding([4, 10]);
    let title: Element<'a, Message> = if ctx.input.rooms.is_empty() {
        title.into()
    } else {
        tooltip(
            title,
            label(ctx.copy.rooms(), 13.0, c.text),
            tooltip::Position::Bottom,
        )
        .into()
    };

    let mut contents = column![container(title).center_x(Fill)]
        .width(Fill)
        .padding(iced::Padding {
            top: if compact { 18.0 } else { 22.0 },
            ..Default::default()
        });
    if ctx.state.rooms_open && !ctx.input.rooms.is_empty() {
        contents = contents.push(room_list(ctx));
    } else {
        let status = room_status(ctx, current);
        contents = contents.push(
            container(label(status, 15.0, c.secondary).font(NUMBER_FONT))
                .center_x(Fill)
                .padding([4, 12]),
        );
    }

    let bar = container(contents)
        .width(Fill)
        .height(ctx.layout.room_height);
    if ctx.input.rooms.is_empty() || ctx.input.chat_open && ctx.layout.size.width <= 1180.0 {
        bar.into()
    } else {
        mouse_area(bar)
            .on_enter(ctx.action(Action::RoomsHovered(true)))
            .on_exit(ctx.action(Action::RoomsHovered(false)))
            .into()
    }
}

fn room_status<Message>(ctx: &View<'_, '_, Message>, current: Option<&RoomIndicator>) -> String {
    let Some(current) = current else {
        return ctx.copy.no_rooms_body().into();
    };
    let voice = ctx.input.voice;
    if voice.room.as_ref() == Some(&current.id) {
        return if voice.listen_only {
            ctx.copy.listen_only().into()
        } else {
            ctx.copy.in_voice(&clock(
                ctx.state
                    .now
                    .saturating_duration_since(ctx.details.joined_at.unwrap_or(ctx.state.began))
                    .as_secs(),
            ))
        };
    }
    if let Some(room) = ctx
        .input
        .rooms
        .iter()
        .find(|r| Some(&r.id) == voice.room.as_ref())
    {
        return ctx.copy.elsewhere(&room.name);
    }
    if current.occupancy == 0 {
        ctx.copy.nobody().into()
    } else {
        ctx.copy.outside().into()
    }
}

fn clock(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = seconds / 60 % 60;
    let seconds = seconds % 60;
    if hours == 0 {
        format!("{minutes:02}:{seconds:02}")
    } else {
        format!("{hours}:{minutes:02}:{seconds:02}")
    }
}

fn room_list<'a, Message: Clone + 'a>(ctx: &View<'_, '_, Message>) -> Element<'a, Message> {
    let chip_width = if ctx.layout.compact { 200.0 } else { 232.0 };
    let side = if ctx.layout.compact { 16.0 } else { 24.0 };
    let available = (ctx.layout.size.width - side * 2.0).max(1.0);
    let mut row = Row::with_capacity(ctx.input.rooms.len()).spacing(4);
    for (index, room) in ctx.input.rooms.iter().enumerate() {
        row = row.push(chip(ctx, index, room, chip_width));
    }
    let row_width = (chip_width + 4.0) * ctx.input.rooms.len() as f32 - 4.0;
    let line: Element<'a, Message> = if row_width > available {
        scrollable(row)
            .direction(scrollable::Direction::Horizontal(
                scrollable::Scrollbar::new().width(0).scroller_width(0),
            ))
            .width(Fill)
            .into()
    } else if ctx.layout.compact {
        container(row).width(Fill).into()
    } else {
        container(row).center_x(Fill).into()
    };
    container(line).width(Fill).padding([14.0, side]).into()
}

fn chip<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    index: usize,
    room: &RoomIndicator,
    width: f32,
) -> Element<'a, Message> {
    let c = ctx.color;
    let mark = Orb::still(
        Slot::Room(index),
        &format!("room-{}", room.id),
        style::palette(style::room_palette(index), ctx.input.theme),
        if room.occupancy == 0 { 0.5 } else { 1.0 },
    );
    let mut name = row![single_line(room.name.clone(), 15.0, c.text)]
        .spacing(6)
        .align_y(iced::Center);
    if room.in_voice {
        name = name.push(icon(Icon::Mic, 16.0, c.text));
    }
    if room.unread > 0 {
        name = name.push(dot(c.invert));
    }

    let occupancy = if room.occupancy == 0 {
        ctx.copy.nobody().to_owned()
    } else {
        ctx.details
            .room_people
            .iter()
            .find(|names| names.room == &room.id && !names.names.is_empty())
            .map_or_else(
                || ctx.copy.voice_count(room.occupancy),
                |names| names.names.to_owned(),
            )
    };
    let words = container(column![name, single_line(occupancy, 13.0, c.secondary)].spacing(2))
        .width(Fill)
        .clip(true);
    let content = row![shader(mark).width(44).height(44), words]
        .spacing(12)
        .align_y(iced::Center);
    let press = super::controls::press(
        content,
        Some(ctx.intent(ShellAction::ViewRoom(room.id.clone()))),
        Color::TRANSPARENT,
        c.fill,
        30.0,
    )
    .padding(iced::Padding {
        left: 8.0,
        right: 14.0,
        bottom: 8.0,
        top: 8.0,
    })
    .width(width)
    .height(60);
    if room.viewed {
        surface(press, 30.0, c.raised).into()
    } else {
        press.into()
    }
}

pub(super) fn dot<'a, Message: 'a>(fill: Color) -> Canvas<Shape, Message> {
    Canvas::new(Shape { fill, radius: 4.0 }).width(8).height(8)
}

pub(super) fn notice<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
) -> Option<Element<'a, Message>> {
    let message = match (ctx.input.voice.joining.is_some(), ctx.details.notice) {
        (true, _) if ctx.input.voice.room.is_none() => ctx.copy.joining(),
        (_, Some(ConnectionNotice::Reconnecting)) => ctx.copy.reconnecting(),
        (_, Some(ConnectionNotice::ReconnectingVoice)) => ctx.copy.reconnecting_voice(),
        _ => return None,
    };
    let c = ctx.color;
    let line = surface(
        container(
            row![dot(c.invert), label(message, 13.0, c.text)]
                .align_y(iced::Center)
                .spacing(8),
        )
        .padding([6, 12]),
        16.0,
        c.raised,
    );
    Some(at(
        container(line).center_x(Fill),
        Rectangle {
            x: 0.0,
            y: ctx.layout.room_height,
            width: ctx.layout.size.width,
            height: 32.0,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_voice_clock_with_optional_hours() {
        assert_eq!(clock(0), "00:00");
        assert_eq!(clock(65), "01:05");
        assert_eq!(clock(3665), "1:01:05");
    }
}
