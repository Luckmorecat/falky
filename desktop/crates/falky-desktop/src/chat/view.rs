use std::collections::HashMap;

use chrono::{Datelike, Local, NaiveDate};
use falky_core::{
    ApiError,
    attachments::{is_available, is_image},
    chat::{FeedItem, MESSAGE_MAX, RoomTimeline, can_post, feed, split_links},
    model::{
        Attachment, AttachmentId, Message as ChatMessage, MessageId, MessageReaction, MessageReply,
        VisitorId,
    },
};
use iced::{
    Background, Border, Color, ContentFit, Element, Fill, Font, Length, Pixels, Rectangle,
    Renderer, Shadow, Theme, Vector,
    advanced::{
        Layout, Widget,
        layout::{self, Limits},
        renderer,
        text::Renderer as TextRenderer,
        widget::{
            Tree,
            operation::{Operation, Outcome, Scrollable},
            tree,
        },
    },
    alignment::{Horizontal, Vertical},
    keyboard::{Key as KeyboardKey, key::Named},
    mouse,
    widget::{
        Id, Svg, button, column, container, image, mouse_area, opaque, rich_text, row, rule,
        scrollable, space, span, stack, svg, text, text_editor, tooltip,
    },
};

use crate::ui_contract::{EffectiveTheme, Language};

use super::{
    Chat, Compose, Composer, Draft, DraftState, FEED, Message, Modal, Notice, Pending, composer_id,
    images,
    images::{InputError, Key, Size},
};

const FIELD_RADIUS: f32 = 16.0;
const CARD_RADIUS: f32 = FIELD_RADIUS + 12.0;
const REACTIONS: Font = Font::with_name("Falky Reactions");

#[derive(Clone, Copy)]
struct Colors {
    body: Color,
    muted: Color,
    faint: Color,
    panel: Color,
    wash: Color,
    raised_wash: Color,
    shadow: Color,
    invert: Color,
    danger: Color,
}

impl Colors {
    fn new(theme: EffectiveTheme) -> Self {
        let light = theme == EffectiveTheme::Light;
        let wash = if light { Color::BLACK } else { Color::WHITE };
        Self {
            body: if light {
                Color::from_rgb8(17, 17, 17)
            } else {
                Color::WHITE
            },
            muted: Color { a: 0.62, ..wash },
            faint: Color {
                a: if light { 0.56 } else { 0.48 },
                ..wash
            },
            panel: if light {
                Color::from_rgb8(242, 242, 242)
            } else {
                Color::from_rgb8(42, 42, 41)
            },
            wash: Color {
                a: if light { 0.06 } else { 0.09 },
                ..wash
            },
            raised_wash: Color {
                a: if light { 0.12 } else { 0.17 },
                ..wash
            },
            shadow: Color {
                a: if light { 0.14 } else { 0.60 },
                ..Color::BLACK
            },
            invert: if light { Color::WHITE } else { Color::BLACK },
            danger: if light {
                Color::from_rgb8(198, 52, 45)
            } else {
                Color::from_rgb8(251, 142, 117)
            },
        }
    }
}

type IdentityColor<'a> = dyn Fn(&VisitorId) -> Option<Color> + 'a;

#[derive(Clone, Copy)]
struct RowPresentation {
    width: f32,
    language: Language,
    theme: EffectiveTheme,
    palette: Colors,
    author_color: Color,
}

impl Chat {
    pub fn view(
        &self,
        room_name: &str,
        language: Language,
        theme: EffectiveTheme,
    ) -> Element<'_, Message> {
        self.view_with_colours(room_name, language, theme, &|_| None)
    }

    pub fn view_with_colours(
        &self,
        room_name: &str,
        language: Language,
        theme: EffectiveTheme,
        identity_color: &IdentityColor<'_>,
    ) -> Element<'_, Message> {
        let palette = Colors::new(theme);
        let close = label_icon(
            CLOSE,
            localized(language, "Close chat", "Закрити чат"),
            Some(Message::CloseChat),
            palette,
            false,
        );
        let heading = row![
            text(room_name.to_owned())
                .size(14)
                .color(palette.muted)
                .width(Fill),
            close
        ]
        .align_y(Vertical::Center);
        let Some(room_id) = &self.view_room else {
            return card(column![heading], palette);
        };
        let Some(composer) = self.composers.get(room_id) else {
            return card(column![heading], palette);
        };
        let timeline = self.timeline.room(room_id);
        let mut rows = column![].width(Fill).spacing(8);
        if timeline.is_some_and(|room| room.has_older) {
            let loading = self.older.contains(room_id);
            rows = rows.push(
                container(control(
                    if loading {
                        localized(language, "Loading", "Завантажуємо")
                    } else {
                        localized(
                            language,
                            "Load older messages",
                            "Завантажити попередні повідомлення",
                        )
                    },
                    (!loading).then_some(Message::Older),
                    palette,
                ))
                .center_x(Fill),
            );
        }
        if timeline.is_none_or(|room| room.messages().next().is_none())
            && self.pending.get(room_id).is_none_or(Vec::is_empty)
        {
            rows = rows.push(
                container(
                    column![
                        text(localized(language, "Nothing here yet", "Тут ще порожньо"))
                            .size(16)
                            .color(palette.body),
                        text(localized(
                            language,
                            "Write the first message.",
                            "Напиши перше повідомлення."
                        ))
                        .size(13)
                        .color(palette.muted),
                    ]
                    .spacing(4)
                    .align_x(Horizontal::Center),
                )
                .center_x(Fill)
                .padding([12, 0]),
            );
        }
        if let Some(timeline) = timeline {
            let gallery_width = self.view_width;
            for item in feed(timeline.messages(), self.new_after.as_ref()) {
                let row: Element<'_, Message> = match item {
                    FeedItem::Day(day) => {
                        container(text(day_label(day, language)).size(12).color(palette.faint))
                            .center_x(Fill)
                            .padding([6, 0])
                            .into()
                    }
                    FeedItem::New => row![
                        text(localized(language, "New messages", "Нові повідомлення"))
                            .size(12)
                            .color(palette.body),
                        rule::horizontal(1),
                    ]
                    .spacing(8)
                    .align_y(Vertical::Center)
                    .into(),
                    FeedItem::Row { message, continued } => container(self.message_row(
                        timeline,
                        message,
                        continued,
                        RowPresentation {
                            width: gallery_width,
                            language,
                            theme,
                            palette,
                            author_color:
                                identity_color(&message.author_id).unwrap_or(palette.body),
                        },
                    ))
                    .id(message_widget_id(&message.id))
                    .into(),
                };
                rows = rows.push(row);
            }
        }
        if let Some(pending) = self.pending.get(room_id) {
            for post in pending {
                rows = rows.push(pending_row(post, language, palette));
            }
        }
        let room = room_id.clone();
        let scroll = scrollable(container(rows).padding([12, 8]).width(Fill))
            .id(FEED)
            .anchor_bottom()
            .width(Fill)
            .height(Fill)
            .on_scroll(move |viewport| Message::Scroll(room.clone(), viewport));
        let latest = if self.scroll.get(room_id).copied().unwrap_or(0.0) > 48.0 {
            container(control(
                localized(language, "Latest", "До останніх"),
                Some(Message::Latest),
                palette,
            ))
            .center_x(Fill)
        } else {
            container(space().height(0))
        };

        card(
            column![
                heading,
                scroll,
                latest,
                self.composer(composer, timeline, language, palette),
            ]
            .spacing(6),
            palette,
        )
    }

    fn message_row<'a>(
        &'a self,
        timeline: &'a RoomTimeline,
        message: &'a ChatMessage,
        continued: bool,
        presentation: RowPresentation,
    ) -> Element<'a, Message> {
        let RowPresentation {
            width,
            language,
            theme,
            palette,
            author_color,
        } = presentation;
        let own = message.author_id == self.identity.id;
        let alignment = if own {
            Horizontal::Right
        } else {
            Horizontal::Left
        };
        let name_color = author_color;
        let button_color = Color {
            a: 0.2,
            ..name_color
        };
        let author = if !continued {
            row![
                text(message.author_name.as_str())
                    .size(14)
                    .color(name_color),
                text(
                    message
                        .created_at
                        .with_timezone(&Local)
                        .format("%H:%M")
                        .to_string()
                )
                .size(11)
                .color(palette.faint),
            ]
            .spacing(6)
            .align_y(Vertical::Center)
        } else {
            row![]
        };
        let mut content = column![author].spacing(3).align_x(alignment);
        if let Some(reply) = &message.reply_to {
            content = content.push(quote(&timeline.reply(reply), language, palette));
        }
        if message.deleted {
            content = content.push(
                text(localized(
                    language,
                    "Message deleted",
                    "Повідомлення видалено",
                ))
                .size(13)
                .color(palette.faint)
                .font(Font {
                    style: iced::font::Style::Italic,
                    ..Font::DEFAULT
                }),
            );
        } else {
            let attachments = self.gallery(&message.attachments, width, language, palette);
            content = content.push(attachments);
            if !message.body.is_empty() {
                let body = link_text(&message.body, palette.body);
                let bubble = container(body)
                    .padding([4, 8])
                    .style(move |_| container::Style {
                        background: own.then_some(Background::Color(button_color)),
                        border: Border {
                            radius: 15.0.into(),
                            ..Border::default()
                        },
                        ..container::Style::default()
                    });
                content = content.push(bubble);
            }
            if message.edited_at.is_some() {
                content = content.push(
                    text(localized(language, "edited", "змінено"))
                        .size(11)
                        .color(palette.faint),
                );
            }
            if !message.reactions.is_empty() {
                let mut reactions = row![].spacing(4);
                for reaction in MessageReaction::ALL {
                    if let Some(group) = message.reactions.iter().find(|g| g.reaction == reaction) {
                        let mine = group.visitor_ids.contains(&self.identity.id);
                        let chip = row![
                            text(emoji(reaction)).font(REACTIONS).size(15),
                            text(group.visitor_ids.len().to_string()).size(12),
                        ]
                        .spacing(4)
                        .align_y(Vertical::Center);
                        reactions = reactions.push(tooltip(
                            button(chip)
                                .style(move |_, status| button_style(palette, status, mine))
                                .padding([4, 7])
                                .on_press(Message::React(message.id.clone(), reaction)),
                            text(reaction_name(reaction, language)).size(12),
                            tooltip::Position::Top,
                        ));
                    }
                }
                content = content.push(reactions.wrap());
            }
        }

        let action = if message.deleted {
            container(space().width(12))
        } else {
            let label = localized(language, "Message actions", "Дії з повідомленням");
            let action = Message::Actions(message.id.clone());
            container(match theme {
                EffectiveTheme::Dark => message_action::<false>(label, action),
                EffectiveTheme::Light => message_action::<true>(label, action),
            })
        };
        if own {
            row![action, container(content).align_x(alignment).width(Fill)]
                .align_y(Vertical::Top)
                .into()
        } else {
            row![container(content).align_x(alignment).width(Fill), action]
                .align_y(Vertical::Top)
                .into()
        }
    }

    fn gallery<'a>(
        &'a self,
        attachments: &'a [Attachment],
        width: f32,
        language: Language,
        palette: Colors,
    ) -> Element<'a, Message> {
        if attachments.is_empty() {
            return space().into();
        }
        let images = attachments
            .iter()
            .filter(|a| is_image(&a.content_type))
            .collect::<Vec<_>>();
        let files = attachments.iter().filter(|a| !is_image(&a.content_type));
        let mut contents = column![].spacing(4);
        let gap = 3.0;
        let width = width.max(115.0);
        let (width, height) = images::gallery_size(&images, width);
        let tile =
            |a: &Attachment, width, height| self.image_tile(a, width, height, language, palette);
        let gallery: Element<'a, Message> = match images.as_slice() {
            [] => space().height(0).into(),
            [one] => tile(one, width, height),
            [one, two] => {
                let w = (width - gap) / 2.0;
                row![tile(one, w, height), tile(two, w, height)]
                    .spacing(gap)
                    .into()
            }
            [one, two, three] => {
                let w = (width - gap) / 3.0;
                let h = (height - gap) / 2.0;
                row![
                    tile(one, w * 2.0, height),
                    column![tile(two, w, h), tile(three, w, h)].spacing(gap),
                ]
                .spacing(gap)
                .into()
            }
            [one, two, three, four, ..] => {
                let w = (width - gap) / 2.0;
                let h = (height - gap) / 2.0;
                column![
                    row![tile(one, w, h), tile(two, w, h)].spacing(gap),
                    row![tile(three, w, h), tile(four, w, h)].spacing(gap),
                ]
                .spacing(gap)
                .into()
            }
        };
        contents = contents.push(container(gallery).clip(true));
        for a in files {
            let label = if is_available(a) {
                format!("{} · {}", a.filename, format_bytes(a.size, language))
            } else {
                format!(
                    "{} · {}",
                    a.filename,
                    localized(language, "Unavailable", "Недоступний")
                )
            };
            contents = contents.push(
                container(text(label).size(12).color(palette.muted))
                    .padding([5, 9])
                    .style(move |_| surface(palette.wash, 12.0)),
            );
        }
        contents.into()
    }

    fn image_tile(
        &self,
        attachment: &Attachment,
        width: f32,
        height: f32,
        language: Language,
        palette: Colors,
    ) -> Element<'_, Message> {
        let id = &attachment.id;
        let key = Key(id.clone(), Size::Thumbnail);
        let available = is_available(attachment);
        let handle = self
            .validated
            .contains(&key)
            .then(|| self.cache.peek(&key))
            .flatten();
        let caption = if !available {
            localized(
                language,
                "Image no longer available",
                "Зображення більше недоступне",
            )
        } else if self.image_errors.contains(&key) {
            localized(
                language,
                "Couldn't show the image",
                "Не вдалося показати зображення",
            )
        } else {
            localized(language, "Loading", "Завантажуємо")
        };
        let visual: Element<'_, Message> = if let Some(cached) = handle.filter(|_| available) {
            image(cached.decoded.handle.clone())
                .height(Fill)
                .width(Fill)
                .content_fit(ContentFit::Cover)
                .into()
        } else {
            container(
                text(caption)
                    .size(11)
                    .color(palette.muted)
                    .align_x(Horizontal::Center),
            )
            .center(Fill)
            .padding(5)
            .into()
        };
        let button = button(visual)
            .width(Fill)
            .height(Fill)
            .padding(0)
            .style(move |_, _| button::Style {
                background: Some(Background::Color(palette.wash)),
                border: Border {
                    radius: 8.0.into(),
                    ..Border::default()
                },
                ..button::Style::default()
            })
            .on_press_maybe(if self.image_errors.contains(&key) {
                available.then(|| Message::RetryImage(id.clone()))
            } else {
                handle.is_some().then(|| Message::OpenImage(id.clone()))
            });
        container(button)
            .width(width)
            .height(height)
            .id(image_widget_id(id))
            .clip(true)
            .into()
    }

    fn composer<'a>(
        &'a self,
        composer: &'a Composer,
        timeline: Option<&RoomTimeline>,
        language: Language,
        palette: Colors,
    ) -> Element<'a, Message> {
        let mut contents = column![].spacing(5).width(Fill);
        let editing = matches!(composer.mode, Some(Compose::Edit { .. }));
        if let Some(mode) = &composer.mode {
            let description = match mode {
                Compose::Reply(reply) => {
                    if language == Language::Uk {
                        format!("Відповідь для {}", reply.author_name)
                    } else {
                        format!("Replying to {}", reply.author_name)
                    }
                }
                Compose::Edit { .. } => {
                    localized(language, "Editing message", "Редагування повідомлення").to_owned()
                }
            };
            contents = contents.push(
                container(
                    row![
                        text(description).size(13).color(palette.body).width(Fill),
                        control(
                            localized(language, "Cancel", "Скасувати"),
                            Some(Message::CancelCompose),
                            palette
                        ),
                    ]
                    .align_y(Vertical::Center),
                )
                .padding([4, 7])
                .style(move |_| surface(palette.wash, FIELD_RADIUS)),
            );
        }
        if !editing && !composer.drafts.is_empty() {
            let mut drafts = row![].spacing(5);
            for draft in &composer.drafts {
                drafts = drafts.push(draft_badge(draft, language, palette));
            }
            contents = contents.push(drafts.wrap());
        }
        if let Some(notice) = &composer.notice {
            contents = contents.push(
                text(notice_text(notice, language, self.limits.count))
                    .size(12)
                    .color(palette.danger),
            );
        }
        if self.dropping {
            contents = contents.push(
                container(
                    text(localized(language, "Drop to add", "Відпусти, щоб додати"))
                        .size(13)
                        .color(palette.body),
                )
                .padding(7)
                .center_x(Fill)
                .style(move |_| surface(palette.wash, FIELD_RADIUS)),
            );
        }

        let body = composer.content.text();
        let count = body.chars().count();
        if count > MESSAGE_MAX - 300 {
            let tone = if count > MESSAGE_MAX {
                palette.danger
            } else {
                palette.muted
            };
            contents = contents.push(
                container(text(format!("{count}/{MESSAGE_MAX}")).size(11).color(tone))
                    .align_x(Horizontal::Right)
                    .width(Fill),
            );
        }
        let attachments = composer
            .drafts
            .iter()
            .filter(|d| matches!(d.state, DraftState::Ready(_)))
            .count();
        let edited = if let Some(Compose::Edit { id, .. }) = &composer.mode {
            timeline.and_then(|r| r.get(id)).filter(|m| !m.deleted)
        } else {
            None
        };
        let allowed = can_post(&body, edited.map_or(attachments, |m| m.attachments.len()))
            && !composer.importing
            && !composer
                .drafts
                .iter()
                .any(|d| matches!(d.state, DraftState::Uploading(_)));
        let empty = count == 0 && !editing;
        let editor = text_editor(&composer.content)
            .id(composer_id())
            .placeholder(localized(language, "Message", "Повідомлення"))
            .on_action(Message::EditInput)
            .height(Length::Shrink)
            .max_height(111)
            .padding(8)
            .key_binding(move |key| {
                use text_editor::{Binding, Status};
                if matches!(key.status, Status::Focused { .. }) {
                    if key.key == KeyboardKey::Named(Named::Enter) && !key.modifiers.shift() {
                        return Some(Binding::Custom(Message::Send));
                    }
                    if key.key == KeyboardKey::Named(Named::ArrowUp)
                        && empty
                        && key.modifiers.is_empty()
                    {
                        return Some(Binding::Custom(Message::EditLast));
                    }
                    if key.key.to_latin(key.physical_key) == Some('v')
                        && key.modifiers.command()
                        && !key.modifiers.alt()
                    {
                        if editing {
                            return Some(Binding::Paste);
                        }
                        return Some(Binding::Custom(Message::Paste));
                    }
                }
                Binding::from_key_press(key)
            })
            .style(move |_, _| text_editor::Style {
                background: Background::Color(Color::TRANSPARENT),
                border: Border::default(),
                placeholder: palette.faint,
                value: palette.body,
                selection: palette.raised_wash,
            });
        let attach = label_icon(
            IMAGE,
            localized(language, "Add image", "Додати зображення"),
            (!editing && !composer.importing && composer.drafts.len() < self.limits.count)
                .then_some(Message::Pick),
            palette,
            false,
        );
        let send = label_icon(
            SEND,
            localized(language, "Send", "Надіслати"),
            allowed.then_some(Message::Send),
            palette,
            true,
        );
        contents
            .push(
                container(
                    row![attach, editor, send]
                        .spacing(4)
                        .align_y(Vertical::Bottom),
                )
                .width(Fill)
                .padding(4)
                .style(move |_| surface(palette.wash, FIELD_RADIUS)),
            )
            .into()
    }

    pub fn modal(&self, language: Language, theme: EffectiveTheme) -> Option<Element<'_, Message>> {
        let palette = Colors::new(theme);
        let room = self.view_room.as_ref()?;
        let close = label_icon(
            CLOSE,
            localized(language, "Close", "Закрити"),
            Some(Message::CloseModal),
            palette,
            false,
        );
        let (contents, width) = match self.modal.as_ref()? {
            Modal::Image(id) => {
                let available = self.attachment(room, id).is_some_and(is_available);
                let key = Key(id.clone(), Size::Viewer);
                let image = self
                    .validated
                    .contains(&key)
                    .then(|| self.cache.peek(&key))
                    .flatten();
                let contents: Element<'_, Message> = match image.filter(|_| available) {
                    Some(image) => iced::widget::image(image.decoded.handle.clone())
                        .width(Fill)
                        .height(Fill)
                        .content_fit(ContentFit::Contain)
                        .into(),
                    None => {
                        let label = if !available {
                            localized(
                                language,
                                "Image no longer available",
                                "Зображення більше недоступне",
                            )
                        } else if self.image_errors.contains(&key) {
                            localized(
                                language,
                                "Couldn't show the image",
                                "Не вдалося показати зображення",
                            )
                        } else {
                            localized(language, "Loading", "Завантажуємо")
                        };
                        let mut placeholder = column![text(label).color(palette.muted)].spacing(8);
                        if available && self.image_errors.contains(&key) {
                            placeholder = placeholder.push(control(
                                localized(language, "Retry", "Повторити"),
                                Some(Message::RetryImage(id.clone())),
                                palette,
                            ));
                        }
                        container(placeholder).center(Fill).into()
                    }
                };
                (
                    column![
                        row![
                            text(localized(language, "Image viewer", "Перегляд зображення"))
                                .color(palette.body)
                                .width(Fill),
                            close
                        ]
                        .align_y(Vertical::Center),
                        container(contents).width(Fill).height(Fill),
                    ]
                    .height(Fill)
                    .spacing(8),
                    1100.0,
                )
            }
            Modal::Actions(id) => {
                let message = self.timeline.room(room)?.get(id)?;
                let mut reactions = row![].spacing(3);
                for reaction in MessageReaction::ALL {
                    let mine = message.reactions.iter().any(|group| {
                        group.reaction == reaction && group.visitor_ids.contains(&self.identity.id)
                    });
                    reactions = reactions.push(tooltip(
                        button(text(emoji(reaction)).font(REACTIONS).size(22))
                            .padding([6, 7])
                            .on_press(Message::React(id.clone(), reaction))
                            .style(move |_, status| button_style(palette, status, mine)),
                        text(reaction_name(reaction, language)).size(12),
                        tooltip::Position::Top,
                    ));
                }
                let mut controls = column![
                    row![
                        text(localized(
                            language,
                            "Message actions",
                            "Дії з повідомленням"
                        ))
                        .width(Fill)
                        .color(palette.body),
                        close
                    ]
                    .align_y(Vertical::Center),
                    reactions,
                    control(
                        localized(language, "Reply", "Відповісти"),
                        Some(Message::Reply(id.clone())),
                        palette
                    ),
                    control(
                        localized(language, "Copy", "Копіювати"),
                        Some(Message::Copy(id.clone())),
                        palette
                    ),
                ]
                .spacing(7);
                if message.author_id == self.identity.id {
                    controls = controls.push(control(
                        localized(language, "Edit", "Змінити"),
                        Some(Message::Edit(id.clone())),
                        palette,
                    ));
                    controls = controls.push(control(
                        localized(language, "Delete", "Видалити"),
                        Some(Message::AskDelete(id.clone())),
                        palette,
                    ));
                }
                (controls, 305.0)
            }
            Modal::Delete(id) => (
                column![
                    row![
                        text(localized(
                            language,
                            "Delete this message?",
                            "Видалити повідомлення?"
                        ))
                        .size(17)
                        .color(palette.body)
                        .width(Fill),
                        close
                    ]
                    .align_y(Vertical::Center),
                    text(localized(
                        language,
                        "You can't get it back.",
                        "Повернути його не вийде."
                    ))
                    .size(13)
                    .color(palette.muted),
                    row![
                        control(
                            localized(language, "Cancel", "Скасувати"),
                            Some(Message::CloseModal),
                            palette
                        ),
                        control(
                            localized(language, "Delete", "Видалити"),
                            Some(Message::ConfirmDelete(id.clone())),
                            Colors {
                                body: palette.danger,
                                ..palette
                            }
                        ),
                    ]
                    .spacing(5)
                ]
                .spacing(8),
                320.0,
            ),
        };

        let overlay = mouse_area(
            container(space())
                .width(Fill)
                .height(Fill)
                .style(|_| surface(Color::from_rgba(0.0, 0.0, 0.0, 0.45), 0.0)),
        )
        .on_press(Message::CloseModal);
        let panel = opaque(
            container(contents)
                .padding(14)
                .width(Fill)
                .max_width(width)
                .style(move |_| surface(palette.panel, CARD_RADIUS)),
        );
        Some(stack![overlay, container(panel).padding(22).center(Fill)].into())
    }
}

fn card<'a>(contents: iced::widget::Column<'a, Message>, palette: Colors) -> Element<'a, Message> {
    opaque(
        container(contents)
            .width(Fill)
            .height(Fill)
            .padding(12)
            .style(move |_| container::Style {
                shadow: Shadow {
                    color: palette.shadow,
                    offset: Vector::new(0.0, 12.0),
                    blur_radius: 34.0,
                },
                border: Border {
                    color: palette.wash,
                    width: 1.0,
                    radius: CARD_RADIUS.into(),
                },
                ..surface(palette.panel, CARD_RADIUS)
            }),
    )
}

fn pending_row(post: &Pending, language: Language, palette: Colors) -> Element<'_, Message> {
    let mut content = column![].spacing(3).align_x(Horizontal::Right);
    if let Some(reply) = &post.reply {
        content = content.push(quote(reply, language, palette));
    }
    if !post.images.is_empty() {
        let mut pictures = row![].spacing(4);
        for draft in &post.images {
            pictures = pictures.push(
                image(draft.preview.clone())
                    .width(46)
                    .height(46)
                    .content_fit(ContentFit::Cover),
            );
        }
        content = content.push(pictures);
    }
    if !post.payload.body.is_empty() {
        content = content.push(
            container(link_text(&post.payload.body, palette.muted))
                .padding([4, 8])
                .style(move |_| surface(palette.wash, 15.0)),
        );
    }
    if let Some(error) = &post.error {
        content = content.push(
            text(post_error(error, language))
                .size(12)
                .color(palette.danger),
        );
        content = content.push(
            row![
                control(
                    localized(language, "Retry", "Повторити"),
                    Some(Message::RetryPost(post.payload.request_key.clone())),
                    palette
                ),
                control(
                    localized(language, "Discard", "Прибрати"),
                    Some(Message::DiscardPost(post.payload.request_key.clone())),
                    palette
                ),
            ]
            .spacing(3),
        );
    } else {
        content = content.push(
            text(localized(language, "Sending", "Надсилається"))
                .size(11)
                .color(palette.faint),
        );
    }
    container(content)
        .width(Fill)
        .align_x(Horizontal::Right)
        .into()
}

fn draft_badge(draft: &Draft, language: Language, palette: Colors) -> Element<'_, Message> {
    let picture = image(draft.preview.clone())
        .width(50)
        .height(42)
        .content_fit(ContentFit::Cover);
    let remove = label_icon(
        CLOSE,
        localized(language, "Remove image", "Прибрати зображення"),
        Some(Message::RemoveDraft(draft.id)),
        palette,
        false,
    );
    let label = match &draft.state {
        DraftState::Uploading(_) => localized(language, "Uploading", "Завантажується"),
        DraftState::Failed(_, error) => upload_error(error, language),
        DraftState::Ready(_) => &draft.name,
    };
    let state = text(label).size(11).color(palette.muted);
    let mut content = column![row![picture, remove].align_y(Vertical::Center), state].spacing(2);
    if matches!(draft.state, DraftState::Failed(..)) {
        content = content.push(control(
            localized(language, "Retry", "Повторити"),
            Some(Message::RetryDraft(draft.id)),
            palette,
        ));
    }
    container(content)
        .max_width(125)
        .padding(4)
        .style(move |_| surface(palette.wash, 10.0))
        .into()
}

fn link_text(body: &str, color: Color) -> Element<'_, Message> {
    let parts = split_links(body)
        .into_iter()
        .map(|part| {
            let text = span(part.text).color(color);
            if part.link {
                text.underline(true).link(part.text.to_owned())
            } else {
                text
            }
        })
        .collect::<Vec<_>>();
    rich_text(parts)
        .size(14)
        .wrapping(iced::widget::text::Wrapping::WordOrGlyph)
        .on_link_click(Message::OpenLink)
        .into()
}

fn quote(reply: &MessageReply, language: Language, palette: Colors) -> Element<'static, Message> {
    let quote = if reply.deleted {
        localized(language, "Message deleted", "Повідомлення видалено").to_owned()
    } else {
        reply.excerpt.clone()
    };
    container(
        column![
            text(reply.author_name.clone())
                .size(12)
                .color(palette.muted),
            text(quote).size(12).color(palette.faint),
        ]
        .spacing(2),
    )
    .padding([4, 8])
    .style(move |_| surface(palette.wash, 7.0))
    .into()
}

fn localized(language: Language, en: &'static str, uk: &'static str) -> &'static str {
    if language == Language::Uk { uk } else { en }
}

pub fn message_summary(message: &ChatMessage, language: Language) -> String {
    if !message.body.trim().is_empty() {
        return message.body.clone();
    }
    let count = message.attachments.len();
    if count == 1 {
        localized(language, "Image", "Зображення").to_owned()
    } else if language == Language::Uk {
        format!("Зображення: {count}")
    } else {
        format!("{count} images")
    }
}

fn day_label(date: NaiveDate, language: Language) -> String {
    let today = Local::now().date_naive();
    if date == today {
        return localized(language, "Today", "Сьогодні").to_owned();
    }
    if Some(date) == today.pred_opt() {
        return localized(language, "Yesterday", "Вчора").to_owned();
    }
    let uk_months = [
        "січня",
        "лютого",
        "березня",
        "квітня",
        "травня",
        "червня",
        "липня",
        "серпня",
        "вересня",
        "жовтня",
        "листопада",
        "грудня",
    ];
    let en_months = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let month = date.month0() as usize;
    let label = if language == Language::Uk {
        format!("{} {}", date.day(), uk_months[month])
    } else {
        format!("{} {}", en_months[month], date.day())
    };
    if date.year() == today.year() {
        label
    } else if language == Language::Uk {
        format!("{label} {} р.", date.year())
    } else {
        format!("{label}, {}", date.year())
    }
}

fn format_bytes(bytes: u64, language: Language) -> String {
    let units = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while unit < units.len() - 1 && value >= 1024.0 {
        value /= 1024.0;
        unit += 1;
    }
    let mut quantity = if unit > 0 && value < 10.0 && (value * 10.0).round() % 10.0 != 0.0 {
        format!("{value:.1}")
    } else {
        format!("{value:.0}")
    };
    if language == Language::Uk {
        quantity = quantity.replace('.', ",");
    }
    format!("{quantity} {}", units[unit])
}

fn emoji(reaction: MessageReaction) -> &'static str {
    match reaction {
        MessageReaction::Up => "👍",
        MessageReaction::Heart => "❤️",
        MessageReaction::Laugh => "😂",
        MessageReaction::Wow => "😮",
        MessageReaction::Fire => "🔥",
        MessageReaction::Clap => "👏",
    }
}

fn reaction_name(reaction: MessageReaction, language: Language) -> &'static str {
    match reaction {
        MessageReaction::Up => localized(language, "Thumbs up", "Клас"),
        MessageReaction::Heart => localized(language, "Heart", "Серце"),
        MessageReaction::Laugh => localized(language, "Laugh", "Сміх"),
        MessageReaction::Wow => localized(language, "Wow", "Ого"),
        MessageReaction::Fire => localized(language, "Fire", "Вогонь"),
        MessageReaction::Clap => localized(language, "Applause", "Оплески"),
    }
}

fn notice_text(notice: &Notice, language: Language, count: usize) -> String {
    match notice {
        Notice::TooMany => {
            if language == Language::Uk {
                format!("До {count} зображень в одному повідомленні.")
            } else {
                format!("Up to {count} images per message.")
            }
        }
        Notice::Input(InputError::NoImage) => localized(
            language,
            "Only images can be added for now.",
            "Поки що можна додавати лише зображення.",
        )
        .into(),
        Notice::Input(InputError::TooLarge) => localized(
            language,
            "The file is too large — 25 MB at most.",
            "Файл завеликий — до 25 МБ.",
        )
        .into(),
        Notice::Input(InputError::Invalid) => localized(
            language,
            "Couldn't read this image.",
            "Не вдалося прочитати це зображення.",
        )
        .into(),
        Notice::Change(falky_core::chat::Change::Edit(_)) => localized(
            language,
            "Couldn't edit the message",
            "Не вдалося змінити повідомлення",
        )
        .into(),
        Notice::Change(falky_core::chat::Change::Delete) => localized(
            language,
            "Couldn't delete the message",
            "Не вдалося видалити повідомлення",
        )
        .into(),
        Notice::Change(falky_core::chat::Change::Reaction(..)) => localized(
            language,
            "Couldn't add the reaction",
            "Не вдалося додати реакцію",
        )
        .into(),
        Notice::History => localized(
            language,
            "Something went wrong. Try again.",
            "Щось пішло не так. Спробуй ще раз.",
        )
        .into(),
    }
}

fn post_error(error: &ApiError, language: Language) -> &'static str {
    match error.code() {
        Some("rate_limited") => localized(
            language,
            "Too many messages. Wait a little.",
            "Забагато повідомлень. Зачекай трохи.",
        ),
        Some("invalid_attachments") => localized(
            language,
            "The images have expired. Discard the message and add them again.",
            "Зображення вже застаріли. Прибери повідомлення й додай їх знову.",
        ),
        Some("invalid_reply") => localized(
            language,
            "The message you replied to was deleted.",
            "Повідомлення, на яке ти відповідаєш, видалено.",
        ),
        _ if *error == ApiError::Transport => localized(
            language,
            "Can't reach the server.",
            "Немає зв'язку із сервером.",
        ),
        _ => localized(language, "Couldn't send.", "Не вдалося надіслати."),
    }
}

fn upload_error(error: &ApiError, language: Language) -> &'static str {
    match error.code() {
        Some("attachment_too_large") => localized(
            language,
            "The file is too large — 25 MB at most.",
            "Файл завеликий — до 25 МБ.",
        ),
        Some("invalid_image") => localized(
            language,
            "Couldn't read this image.",
            "Не вдалося прочитати це зображення.",
        ),
        Some("image_dimensions") => localized(
            language,
            "The image is too large in size.",
            "Зображення має завеликі розміри.",
        ),
        Some("rate_limited" | "attachment_busy") => localized(
            language,
            "Too many uploads. Wait a moment.",
            "Забагато завантажень. Зачекай трохи.",
        ),
        Some("attachment_capacity" | "attachment_processing" | "attachment_unavailable") => {
            localized(
                language,
                "The server isn't taking files right now. Try later.",
                "Сервер зараз не приймає файли. Спробуй пізніше.",
            )
        }
        Some("upload_timeout") => localized(
            language,
            "The upload took too long.",
            "Завантаження тривало задовго.",
        ),
        _ if *error == ApiError::Transport => localized(
            language,
            "Can't reach the server.",
            "Немає зв'язку із сервером.",
        ),
        _ => localized(language, "Couldn't upload.", "Не вдалося завантажити."),
    }
}

fn surface(color: Color, radius: f32) -> container::Style {
    container::Style {
        background: Some(Background::Color(color)),
        border: Border {
            radius: radius.into(),
            ..Border::default()
        },
        ..container::Style::default()
    }
}

fn button_style(palette: Colors, status: button::Status, emphasized: bool) -> button::Style {
    let (fill, text) = match status {
        button::Status::Disabled => (Color::TRANSPARENT, palette.faint),
        button::Status::Hovered | button::Status::Pressed => (palette.raised_wash, palette.body),
        _ if emphasized => (palette.body, palette.invert),
        _ => (palette.wash, palette.body),
    };
    button::Style {
        background: Some(Background::Color(fill)),
        text_color: text,
        border: Border {
            radius: 12.0.into(),
            ..Border::default()
        },
        ..button::Style::default()
    }
}

fn control(
    label: &'static str,
    message: Option<Message>,
    palette: Colors,
) -> Element<'static, Message> {
    button(text(label).size(12))
        .on_press_maybe(message)
        .padding([5, 9])
        .style(move |_, status| button_style(palette, status, false))
        .into()
}

const CLOSE: &str = r#"<path d="m6.5 6.5 11 11m0-11-11 11"/>"#;
const SEND: &str = r#"<path d="M12 19V6M6.500 11 12 5.500l5.500 5.500"/>"#;
const DOTS: &str = r#"<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>"#;
const IMAGE: &str = r#"<rect x="3.500" y="4.500" width="17" height="15" rx="4"/><circle cx="9" cy="10" r="1.600"/><path d="m20 15.500-4.300-4.300a1.200 1.200 0 0 0-1.700 0L5 20"/>"#;

fn label_icon(
    path: &'static str,
    label: &'static str,
    message: Option<Message>,
    palette: Colors,
    invert: bool,
) -> Element<'static, Message> {
    let glyph = icon_svg(path).style(move |_, _| svg::Style {
        color: Some(if invert {
            palette.invert
        } else {
            palette.muted
        }),
    });
    tooltip(
        button(glyph)
            .on_press_maybe(message)
            .padding(6)
            .style(move |_, status| {
                button_style(
                    Colors {
                        wash: Color::TRANSPARENT,
                        ..palette
                    },
                    status,
                    invert,
                )
            }),
        text(label).size(12),
        tooltip::Position::Top,
    )
    .into()
}

fn icon_svg(path: &'static str) -> Svg<'static> {
    let graphic = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">{path}</svg>"#
    );
    svg(svg::Handle::from_memory(graphic.into_bytes()))
        .width(18)
        .height(18)
}

fn action_palette<const LIGHT: bool>() -> Colors {
    Colors {
        wash: Color::TRANSPARENT,
        ..Colors::new(if LIGHT {
            EffectiveTheme::Light
        } else {
            EffectiveTheme::Dark
        })
    }
}

fn message_action<const LIGHT: bool>(
    label: &'static str,
    action: Message,
) -> Element<'static, Message> {
    let glyph = icon_svg(DOTS).style(|_, _| svg::Style {
        color: Some(action_palette::<LIGHT>().muted),
    });
    tooltip(
        button(glyph)
            .on_press(action)
            .padding(6)
            .style(|_, status| button_style(action_palette::<LIGHT>(), status, false)),
        Element::new(ActionLabel(label)),
        tooltip::Position::Top,
    )
    .into()
}

struct ActionLabel(&'static str);

type ActionLabelState = text::State<<Renderer as TextRenderer>::Paragraph>;

impl Widget<Message, Theme, Renderer> for ActionLabel {
    fn tag(&self) -> tree::Tag {
        tree::Tag::of::<ActionLabelState>()
    }

    fn state(&self) -> tree::State {
        tree::State::new(ActionLabelState::default())
    }

    fn size(&self) -> iced::Size<Length> {
        iced::Size::new(Length::Shrink, Length::Shrink)
    }

    fn layout(&mut self, tree: &mut Tree, renderer: &Renderer, limits: &Limits) -> layout::Node {
        text::layout(
            tree.state.downcast_mut::<ActionLabelState>(),
            renderer,
            limits,
            self.0,
            text::Format {
                size: Some(Pixels(12.0)),
                ..text::Format::default()
            },
        )
    }

    fn draw(
        &self,
        tree: &Tree,
        renderer: &mut Renderer,
        _: &Theme,
        defaults: &renderer::Style,
        layout: Layout<'_>,
        _: mouse::Cursor,
        viewport: &Rectangle,
    ) {
        text::draw(
            renderer,
            defaults,
            layout.bounds(),
            tree.state.downcast_ref::<ActionLabelState>().raw(),
            text::Style::default(),
            viewport,
        );
    }

    fn operate(
        &mut self,
        _: &mut Tree,
        layout: Layout<'_>,
        _: &Renderer,
        operation: &mut dyn Operation,
    ) {
        operation.text(None, layout.bounds(), self.0);
    }
}

pub fn image_widget_id(id: &AttachmentId) -> Id {
    Id::from(format!("falky.chat.attachment.{id}"))
}

pub(super) fn message_widget_id(id: &MessageId) -> Id {
    Id::from(format!("falky.chat.message.{id}"))
}

#[derive(Clone, Debug)]
pub struct FeedAnchor {
    id: Id,
    top: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Measured {
    pub images: Vec<AttachmentId>,
    pub first: Option<FeedAnchor>,
    pub corrected_offset: Option<f32>,
}

pub struct Measure {
    ids: HashMap<Id, AttachmentId>,
    rows: std::collections::HashSet<Id>,
    anchor: Option<FeedAnchor>,
    clip: Option<(Rectangle, Vector, f32)>,
    measured: Measured,
}

impl Measure {
    pub fn new(
        ids: HashMap<Id, AttachmentId>,
        rows: std::collections::HashSet<Id>,
        anchor: Option<FeedAnchor>,
    ) -> Self {
        Self {
            ids,
            rows,
            anchor,
            clip: None,
            measured: Measured::default(),
        }
    }
}

impl Operation<Measured> for Measure {
    fn traverse(&mut self, operate: &mut dyn FnMut(&mut dyn Operation<Measured>)) {
        operate(self);
    }

    fn scrollable(
        &mut self,
        id: Option<&Id>,
        bounds: Rectangle,
        content_bounds: Rectangle,
        translation: Vector,
        _: &mut dyn Scrollable,
    ) {
        if id == Some(&Id::new(FEED)) {
            self.clip = Some((
                bounds,
                translation,
                (content_bounds.height - bounds.height).max(0.0),
            ));
        }
    }

    fn container(&mut self, id: Option<&Id>, bounds: Rectangle) {
        let (Some((clip, translation, extent)), Some(id)) = (self.clip, id) else {
            return;
        };
        let screen_bounds = bounds - translation;
        let visible = clip.intersects(&screen_bounds);
        if let Some(attachment) = self.ids.get(id).filter(|_| visible) {
            self.measured.images.push(attachment.clone());
        }
        let top = screen_bounds.y - clip.y;
        if let Some(anchor) = self.anchor.as_ref().filter(|anchor| anchor.id == *id) {
            let current = extent - translation.y;
            let corrected = (current + anchor.top - top).clamp(0.0, extent);
            if (corrected - current).abs() > 1.0 {
                self.measured.corrected_offset = Some(corrected);
            }
        }
        if self.measured.first.is_none() && visible && self.rows.contains(id) {
            self.measured.first = Some(FeedAnchor {
                id: id.clone(),
                top,
            });
        }
    }

    fn finish(&self) -> Outcome<Measured> {
        Outcome::Some(self.measured.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn message_action_matches_existing_tooltip_and_click() {
        use iced::advanced::{
            Shell, clipboard,
            renderer::{Headless, Renderer as _},
        };
        use iced::{Event, Point, Size};

        let mut renderer = Renderer::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .unwrap();
        let mut snapshots = |mut element: Element<'static, Message>, effective| {
            let theme = crate::shell::theme(effective);
            let size = Size::new(180, 130);
            let logical = Size::new(size.width as f32, size.height as f32);
            let viewport = Rectangle::with_size(logical);
            let mut tree = Tree::new(element.as_widget());
            let node = element
                .as_widget_mut()
                .layout(&mut tree, &renderer, &Limits::new(Size::ZERO, logical))
                .move_to(Point::new(40.0, 65.0));
            let inside = Point::new(54.0, 79.0);
            let outside = Point::ORIGIN;
            let mut messages = Vec::new();
            let mut pictures = Vec::new();
            for (point, event) in [
                (outside, mouse::Event::CursorMoved { position: outside }),
                (inside, mouse::Event::CursorMoved { position: inside }),
                (inside, mouse::Event::ButtonPressed(mouse::Button::Left)),
                (inside, mouse::Event::ButtonReleased(mouse::Button::Left)),
                (outside, mouse::Event::CursorMoved { position: outside }),
                (inside, mouse::Event::CursorMoved { position: inside }),
            ] {
                let cursor = mouse::Cursor::Available(point);
                let layout = Layout::new(&node);
                element.as_widget_mut().update(
                    &mut tree,
                    &Event::Mouse(event),
                    layout,
                    cursor,
                    &renderer,
                    &mut clipboard::Null,
                    &mut Shell::new(&mut messages),
                    &viewport,
                );
                renderer.reset(viewport);
                let style = renderer::Style {
                    text_color: theme.palette().text,
                };
                element.as_widget().draw(
                    &tree,
                    &mut renderer,
                    &theme,
                    &style,
                    layout,
                    cursor,
                    &viewport,
                );
                let mut overlay = element.as_widget_mut().overlay(
                    &mut tree,
                    layout,
                    &renderer,
                    &viewport,
                    Vector::ZERO,
                );
                assert_eq!(overlay.is_some(), point == inside);
                if let Some(overlay) = &mut overlay {
                    let overlay_node = overlay.as_overlay_mut().layout(&renderer, logical);
                    overlay.as_overlay().draw(
                        &mut renderer,
                        &theme,
                        &style,
                        Layout::new(&overlay_node),
                        cursor,
                    );
                }
                drop(overlay);
                pictures.push(renderer.screenshot(size, 1.0, Color::from_rgb8(96, 117, 143)));
            }
            assert!(
                matches!(messages.as_slice(), [Message::Actions(id)] if id.as_str() == "message")
            );
            assert_ne!(pictures[0], pictures[1]);
            assert_eq!(pictures[0], pictures[4]);
            assert_eq!(pictures[1], pictures[5]);
            pictures
        };

        for (theme, label) in [
            (EffectiveTheme::Dark, "Message actions"),
            (EffectiveTheme::Light, "Дії з повідомленням"),
        ] {
            let action = || Message::Actions("message".into());
            let reference = label_icon(DOTS, label, Some(action()), Colors::new(theme), false);
            let compact = match theme {
                EffectiveTheme::Dark => message_action::<false>(label, action()),
                EffectiveTheme::Light => message_action::<true>(label, action()),
            };
            assert_eq!(snapshots(compact, theme), snapshots(reference, theme));
        }
    }

    #[tokio::test]
    async fn empty_gallery_preserves_message_column_spacing() {
        use iced::advanced::layout::Limits;
        use iced::advanced::renderer::Headless;
        use iced::advanced::widget::Tree;
        use iced::{Font, Pixels, Renderer, Size};

        let (chat, _, _) = super::super::tests::setup();
        let renderer = Renderer::new(Font::DEFAULT, Pixels(16.0), Some("tiny-skia"))
            .await
            .unwrap();
        let palette = Colors::new(EffectiveTheme::Dark);
        let gallery = chat.gallery(&[], 222.0, Language::En, palette);
        let reference = iced::widget::column![container(space().height(0)).clip(true)].spacing(4);
        let positions = |gallery: Element<'_, Message>| {
            let mut content: Element<'_, Message> = iced::widget::column![
                space().width(20).height(12),
                gallery,
                space().width(20).height(24)
            ]
            .spacing(3)
            .into();
            let mut tree = Tree::new(content.as_widget());
            let node = content.as_widget_mut().layout(
                &mut tree,
                &renderer,
                &Limits::new(Size::ZERO, Size::new(222.0, 200.0)),
            );
            (
                node.bounds(),
                node.children()
                    .iter()
                    .map(|child| child.bounds())
                    .collect::<Vec<_>>(),
            )
        };
        let actual = positions(gallery);
        assert_eq!(actual, positions(reference.into()));
        assert_eq!(actual.1.len(), 3);
    }

    #[test]
    fn bottom_anchored_feed_restores_the_row_when_history_or_new_rows_move() {
        let id = message_widget_id(&"message".into());
        let clip = Rectangle {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut initial = Measure::new(HashMap::new(), [id.clone()].into(), None);
        initial.clip = Some((clip, Vector::new(0.0, 100.0), 200.0));
        let row = Rectangle {
            x: 0.0,
            y: 80.0,
            width: 100.0,
            height: 40.0,
        };
        initial.container(Some(&id), row);
        let anchor = initial.measured.first;

        let mut appended = Measure::new(HashMap::new(), [id.clone()].into(), anchor.clone());
        appended.clip = Some((clip, Vector::new(0.0, 155.0), 255.0));
        appended.container(Some(&id), row);
        assert_eq!(appended.measured.corrected_offset, Some(155.0));

        let mut prepended = Measure::new(HashMap::new(), [id.clone()].into(), anchor);
        prepended.clip = Some((clip, Vector::new(0.0, 155.0), 255.0));
        prepended.container(
            Some(&id),
            Rectangle {
                y: row.y + 55.0,
                ..row
            },
        );
        assert_eq!(prepended.measured.corrected_offset, None);
    }
}
