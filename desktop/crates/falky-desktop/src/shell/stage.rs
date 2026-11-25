use super::geometry::{blend, surface};
use super::icon::{Icon, icon};
use super::orb::{Orb, Slot, TALK_PADDING};
use super::rooms::viewed;
use super::style::{self, alpha};
use super::{Action, HEADING_FONT, View, at, label, single_line};
use crate::ui_contract::StageParticipant;
use iced::widget::{Column, Row, Space, Stack, center, column, container, shader, tooltip};
use iced::{Center, Color, Element, Fill, Rectangle};

fn heard_level(person: &StageParticipant) -> f32 {
    if person.muted || person.deafened || person.gain_percent == 0 {
        0.0
    } else {
        person.level.clamp(0.0, 1.0)
    }
}

pub(super) fn active(person: &StageParticipant) -> bool {
    !person.muted
        && !person.deafened
        && person.gain_percent > 0
        && (person.speaking || heard_level(person) > 0.03)
}

fn speaking(person: &StageParticipant) -> bool {
    active(person) && (person.speaking || heard_level(person) > 0.22)
}

pub(super) fn view<'a, Message: Clone + 'a>(ctx: &View<'_, '_, Message>) -> Element<'a, Message> {
    let stage = ctx.input.stage;
    let (fit, gap, reserve) = ctx.layout.stage(stage.len(), ctx.state.rooms_open);
    let frame = Rectangle {
        x: 0.0,
        y: ctx.layout.room_height,
        width: ctx.layout.size.width,
        height: (ctx.layout.size.height - ctx.layout.room_height - reserve).max(1.0),
    };
    let c = ctx.color;
    if viewed(ctx.input.rooms).is_none() || !stage.is_empty() && fit.size < 14.0 {
        return at(Space::new(), frame);
    }
    if stage.is_empty() {
        let empty = column![
            label(ctx.copy.quiet(), 24.0, c.text).font(HEADING_FONT),
            label(ctx.copy.quiet_body(), 15.0, c.secondary).align_x(Center),
        ]
        .spacing(4)
        .align_x(Center);
        return at(center(container(empty).max_width(340)), frame);
    }

    let spotlight = stage.iter().any(speaking);
    let adjusting =
        viewed(ctx.input.rooms).is_some_and(|room| ctx.input.voice.room.as_ref() == Some(&room.id));
    let mut grid = Column::new().spacing(gap).align_x(Center);
    for (row_number, people) in stage.chunks(fit.columns).enumerate() {
        let mut row = Row::new().spacing(gap);
        for (column, person) in people.iter().enumerate() {
            let index = row_number * fit.columns + column;
            row = row.push(tile(
                ctx,
                fit.size,
                index,
                person,
                spotlight,
                adjusting && !person.local,
            ));
        }
        grid = grid.push(row);
    }
    at(center(grid), frame)
}

fn tile<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    size: f32,
    index: usize,
    person: &StageParticipant,
    spotlight: bool,
    adjustable: bool,
) -> Element<'a, Message> {
    let dimmed = spotlight && !speaking(person);
    let opacity = if ctx.state.rooms_open { 0.5 } else { 1.0 };
    let c = ctx.color;
    let gap = (size * 0.045).clamp(7.0, 20.0);
    let name_size = (size * 0.054).clamp(13.0, 22.0);
    let orb_size = (size * 0.78)
        .min((size - name_size - gap - 6.0) / TALK_PADDING)
        .max(1.0);
    let display_size = orb_size * TALK_PADDING;
    let orb = Orb {
        slot: Slot::Stage(index),
        seed: style::hash_string(person.visitor_id.as_str()),
        colors: style::palette(person.palette, ctx.input.theme),
        now: ctx.state.seconds(),
        target_level: heard_level(person),
        still: false,
        grayscale: dimmed
            || person.muted
            || person.deafened
            || adjustable && person.gain_percent == 0,
        reduced_motion: !ctx.details.motion,
        opacity,
    };
    let mut image = Stack::new().push(shader(orb).width(display_size).height(display_size));

    let mut flags = Row::new().spacing(4);
    let flag_size = (size * 0.11).clamp(22.0, 36.0);
    if person.deafened {
        flags = flags.push(flag(
            Icon::HeadOff,
            ctx.copy.deafened(),
            flag_size,
            c.raised,
            c.text,
        ));
    } else if person.muted {
        flags = flags.push(flag(
            Icon::MicOff,
            ctx.copy.muted(),
            flag_size,
            c.raised,
            c.text,
        ));
    }
    if person.camera {
        flags = flags.push(flag(
            Icon::Camera,
            ctx.copy.camera(),
            flag_size,
            c.raised,
            c.text,
        ));
    }
    if person.screen_share {
        flags = flags.push(flag(
            Icon::Screen,
            ctx.copy.screen_share(),
            flag_size,
            c.raised,
            c.text,
        ));
    }
    let inset = (display_size - orb_size) * 0.5 + orb_size * 0.04;
    let overlay = container(flags)
        .align_x(iced::Right)
        .align_y(iced::Bottom)
        .width(Fill)
        .height(Fill)
        .padding(iced::Padding {
            right: inset,
            bottom: inset,
            ..Default::default()
        });
    image = image.push(overlay);

    if adjustable {
        let gain_icon = if person.gain_percent == 0 {
            Icon::SpeakerOff
        } else {
            Icon::Speaker
        };
        let detail = if person.gain_percent == 0 {
            ctx.copy.locally_muted().to_owned()
        } else {
            format!("{} · {}%", ctx.copy.volume(), person.gain_percent)
        };
        let gain = super::controls::icon_button(
            gain_icon,
            detail,
            flag_size,
            c.text,
            c.raised,
            c.raised_hover,
            Some(ctx.action(Action::OpenGain(person.connection_id.clone()))),
        );
        image = image.push(
            container(gain)
                .align_y(iced::Bottom)
                .width(Fill)
                .height(Fill)
                .padding(iced::Padding {
                    left: inset,
                    bottom: inset,
                    ..Default::default()
                }),
        );
    }
    let name = label(
        person.name.clone(),
        name_size,
        blend(
            alpha(c.text, opacity * if dimmed { 0.6 } else { 1.0 }),
            c.background,
        ),
    )
    .font(HEADING_FONT)
    .wrapping(iced::widget::text::Wrapping::None);
    let block = column![image, container(name).max_width(size).clip(true)]
        .spacing(gap)
        .align_x(Center);
    center(block).width(size).height(size).into()
}

fn flag<'a, Message: 'a>(
    name: Icon,
    title: &'static str,
    size: f32,
    background: Color,
    text: Color,
) -> Element<'a, Message> {
    let content = center(icon(name, size * 0.56, text))
        .width(size)
        .height(size);
    tooltip(
        surface(content, size / 2.0, background),
        single_line(title, 13.0, text),
        tooltip::Position::Top,
    )
    .into()
}
