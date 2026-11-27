use super::geometry::surface;
use super::orb::{Orb, Slot};
use super::style;
use super::{HEADING_FONT, View, at, single_line};
use crate::ui_contract::ShellAction;
use iced::widget::{Column, Row, container};
use iced::{Center, Color, Element, Rectangle};

pub(super) fn view<'a, Message: Clone + 'a>(
    ctx: &View<'_, '_, Message>,
    dock_right: f32,
) -> Element<'a, Message> {
    let narrow = ctx.layout.size.width <= 1180.0;
    let items = ctx.input.ticker;
    let start = items.len().saturating_sub(3);
    let shown = &items[start..];
    let width = if narrow {
        (ctx.layout.size.width - 32.0).clamp(1.0, 520.0)
    } else {
        (ctx.layout.size.width - dock_right - 28.0).clamp(1.0, 340.0)
    };
    let left = if narrow {
        (ctx.layout.size.width - width) / 2.0
    } else {
        dock_right + 12.0
    };
    let height = shown.len() as f32 * 36.0 + shown.len().saturating_sub(1) as f32 * 4.0;
    let top = if narrow {
        12.0
    } else {
        (ctx.layout.size.height - ctx.layout.dock_bottom - height).max(0.0)
    };
    let mut lines = Column::new().spacing(4).align_x(if narrow {
        iced::alignment::Horizontal::Center
    } else {
        iced::alignment::Horizontal::Left
    });
    let c = ctx.color;

    for (index, item) in shown.iter().enumerate() {
        let sender = ctx.details.ticker_senders.get(start + index);
        let identity = sender.map_or(item.author.as_str(), |sender| sender.identity);
        let previous = index.checked_sub(1).map(|previous| {
            ctx.details
                .ticker_senders
                .get(start + previous)
                .map_or(shown[previous].author.as_str(), |sender| sender.identity)
        });
        let palette = sender.and_then(|sender| sender.palette);
        let mut content = Row::new().spacing(8).align_y(Center);
        if previous != Some(identity) {
            let colors = palette.map_or([c.muted, c.secondary, c.raised_hover, c.text], |name| {
                style::palette(name, ctx.input.theme)
            });
            let avatar = Orb::still(Slot::Ticker(index), identity, colors, 1.0);
            let tint = palette.map_or(c.secondary, |name| {
                style::identity_name(name, ctx.input.theme)
            });
            content = content
                .push(avatar.view(18.0, ctx.details.simplified_orbs))
                .push(
                    container(single_line(item.author.clone(), 14.0, tint).font(HEADING_FONT))
                        .max_width(width * 0.4)
                        .clip(true),
                );
        }
        content =
            content.push(container(single_line(item.summary.clone(), 15.0, c.text)).clip(true));
        let press = super::controls::press(
            container(content)
                .max_width((width - 28.0).max(1.0))
                .clip(true),
            Some(ctx.intent(ShellAction::ToggleChat)),
            Color::TRANSPARENT,
            c.fill,
            18.0,
        )
        .padding([8, 14])
        .height(36);
        lines = lines.push(surface(press, 18.0, c.raised));
    }

    let line = if narrow {
        container(lines).center_x(width)
    } else {
        container(lines).width(width)
    };
    at(
        line,
        Rectangle {
            x: left,
            y: top,
            width,
            height,
        },
    )
}
