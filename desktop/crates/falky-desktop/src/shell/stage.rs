use super::geometry::{blend, surface};
use super::icon::{Icon, icon};
use super::orb::{Orb, Slot, TALK_PADDING};
use super::rooms::viewed;
use super::share;
use super::style::{self, alpha};
use super::{Action, HEADING_FONT, ShareAction, ShareCaptureStatus, View, at, label, single_line};
use crate::locale::{self, Key};
use crate::ui_contract::StageParticipant;
use iced::widget::{
    Column, Row, Space, Stack, center, column, container, scrollable, shader, tooltip,
};
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

pub(super) fn watched<'a, Message>(ctx: &View<'a, '_, Message>) -> Option<&'a StageParticipant> {
    let selected = ctx.share.selected?;
    let viewed_room = viewed(ctx.input.rooms)?;
    if Some(&viewed_room.id) != ctx.input.voice.room.as_ref() {
        return None;
    }
    ctx.input
        .stage
        .iter()
        .find(|person| person.screen_share && &person.connection_id == selected)
}

pub(super) fn view<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    watching: Option<&StageParticipant>,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let stage = ctx.input.stage;
    let (fit, gap, reserve) = ctx.layout.stage(stage.len(), ctx.state.rooms_open);
    let frame = Rectangle {
        x: 0.0,
        y: ctx.layout.room_height,
        width: ctx.layout.size.width,
        height: (ctx.layout.size.height - ctx.layout.room_height - reserve).max(1.0),
    };
    if let Some(person) = watching {
        return at(with_share(ctx, person, frame.size(), emit), frame);
    }
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
                false,
            ));
        }
        grid = grid.push(row);
    }
    at(center(grid), frame)
}

fn with_share<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    person: &StageParticipant,
    size: iced::Size,
    emit: impl Fn(Action) -> Message + 'a,
) -> Element<'a, Message> {
    let padding = 12.0;
    let width = (size.width - 2.0 * padding).max(1.0);
    let orbs_size = (size.height * 0.25).clamp(56.0, 96.0);
    let gap = 6.0;
    let spotlight = ctx.input.stage.iter().any(speaking);
    let row = Row::with_children(
        ctx.input
            .stage
            .iter()
            .enumerate()
            .map(|(index, participant)| {
                tile(
                    ctx,
                    orbs_size,
                    index,
                    participant,
                    spotlight,
                    !participant.local,
                    true,
                )
            }),
    )
    .spacing(gap);
    let orbs = scrollable(row)
        .direction(scrollable::Direction::Horizontal(
            scrollable::Scrollbar::new().width(3).scroller_width(3),
        ))
        .height(orbs_size + 4.0);
    let viewer = share::inline(
        ctx,
        person,
        iced::Size::new(width, (size.height - orbs_size - 4.0 - gap).max(1.0)),
        emit,
    );
    container(column![viewer, container(orbs).center_x(Fill)].spacing(gap))
        .center_x(Fill)
        .width(Fill)
        .height(Fill)
        .padding(iced::Padding::from([0.0, padding]))
        .into()
}

fn tile<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    size: f32,
    index: usize,
    person: &StageParticipant,
    spotlight: bool,
    adjustable: bool,
    miniature: bool,
) -> Element<'a, Message> {
    let dimmed = spotlight && !speaking(person);
    let opacity = if ctx.state.rooms_open { 0.5 } else { 1.0 };
    let c = ctx.color;
    let gap = if miniature {
        2.0
    } else {
        (size * 0.045).clamp(7.0, 20.0)
    };
    let name_size = if miniature {
        12.0
    } else {
        (size * 0.054).clamp(13.0, 22.0)
    };
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
    let drawing = shader(orb).width(display_size).height(display_size);
    let mut image = if miniature {
        Stack::new().push(container(drawing).center_x(size))
    } else {
        Stack::new().push(drawing)
    };

    let mut flags = Row::new().spacing(4);
    let flag_size = if miniature {
        16.0
    } else {
        (size * 0.11).clamp(22.0, 36.0)
    };
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
        let clickable = ctx.share.capture != ShareCaptureStatus::Hidden
            && viewed(ctx.input.rooms)
                .is_some_and(|room| Some(&room.id) == ctx.input.voice.room.as_ref());
        let status = locale::text(ctx.input.language, Key::SharingScreen);
        let badge = if clickable {
            super::controls::icon_button(
                Icon::Screen,
                status,
                flag_size,
                c.text,
                c.raised,
                c.raised_hover,
                Some(ctx.action(Action::Share(ShareAction::Watch(
                    person.connection_id.clone(),
                )))),
            )
        } else {
            flag(Icon::Screen, status, flag_size, c.raised, c.text)
        };
        if miniature {
            image = image.push(container(badge).align_x(iced::Right).width(Fill));
        } else {
            flags = flags.push(badge);
        }
    }
    let inset = if miniature {
        0.0
    } else {
        (display_size - orb_size) * 0.5 + orb_size * 0.04
    };
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
