use chrono::{Duration, Local, NaiveDate};

use crate::model::{Message, MessageId};

pub const MESSAGE_MAX: usize = 4000;

pub fn can_post(body: &str, attachments: usize) -> bool {
    (!body.trim().is_empty() || attachments > 0) && body.chars().count() <= MESSAGE_MAX
}

pub enum FeedItem<'a> {
    Day(NaiveDate),
    New,
    Row {
        message: &'a Message,
        continued: bool,
    },
}

/// A None boundary disables the divider; Some(None) places it at the first row.
pub fn feed<'a>(
    messages: impl Iterator<Item = &'a Message>,
    new_after: Option<&Option<MessageId>>,
) -> Vec<FeedItem<'a>> {
    let mut items = Vec::new();
    let mut last_day = None;
    let mut last_message: Option<&Message> = None;
    let mut new_after = new_after;
    for message in messages {
        let day = message.created_at.with_timezone(&Local).date_naive();
        if last_day != Some(day) {
            items.push(FeedItem::Day(day));
            last_day = Some(day);
            last_message = None;
        }
        if new_after.is_some_and(|cursor| cursor.as_ref().is_none_or(|id| message.id > *id)) {
            items.push(FeedItem::New);
            new_after = None;
            last_message = None;
        }
        let continued = last_message.is_some_and(|last| {
            last.author_id == message.author_id
                && last.author_name == message.author_name
                && message.created_at - last.created_at < Duration::minutes(5)
        });
        items.push(FeedItem::Row { message, continued });
        last_message = Some(message);
    }
    items
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextPart<'a> {
    pub text: &'a str,
    pub link: bool,
}

pub fn split_links(text: &str) -> Vec<TextPart<'_>> {
    let normalized = text.to_ascii_lowercase();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut pos = 0;
    while let Some(scheme) = next_scheme(&normalized[pos..]) {
        let at = pos + scheme;
        let scheme_length = if normalized[at..].starts_with("https://") {
            8
        } else {
            7
        };
        let tail = &text[at + scheme_length..];
        let length = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '<' | '>' | '"'))
            .unwrap_or(tail.len());
        let candidate = &text[at..at + scheme_length + length];
        let trimmed =
            candidate.trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '»']);
        let link = if candidate[trimmed.len()..].starts_with(')') && trimmed.contains('(') {
            candidate
        } else {
            trimmed
        };
        pos = at + candidate.len();
        if link.len() <= scheme_length {
            continue;
        }
        if at > start {
            parts.push(TextPart {
                text: &text[start..at],
                link: false,
            });
        }
        parts.push(TextPart {
            text: link,
            link: true,
        });
        start = at + link.len();
    }
    if start < text.len() {
        parts.push(TextPart {
            text: &text[start..],
            link: false,
        });
    }
    parts
}

fn next_scheme(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}
