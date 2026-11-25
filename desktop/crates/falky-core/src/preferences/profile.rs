use reqwest::Method;
use serde::Serialize;
use thiserror::Error;

use crate::model::{PaletteName, Visitor, VisitorColour};
use crate::transport::{ApiClient, ApiError};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct VisitorName(String);

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("Invalid visitor name")]
pub struct InvalidVisitorName;

impl VisitorName {
    pub fn parse(raw: &str) -> Result<Self, InvalidVisitorName> {
        let name = raw.trim();
        if name.is_empty() || name.chars().count() > 32 || name.chars().any(forbidden_name_char) {
            return Err(InvalidVisitorName);
        }
        Ok(Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn forbidden_name_char(value: char) -> bool {
    value.is_control()
        || matches!(value, '\u{061c}' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

pub async fn rename(client: &ApiClient, name: &VisitorName) -> Result<Visitor, ApiError> {
    #[derive(Serialize)]
    struct Body<'a> {
        name: &'a VisitorName,
    }

    client
        .json(
            client
                .request(Method::PATCH, &["api", "me"])
                .json(&Body { name }),
        )
        .await
}

pub async fn set_colour(
    client: &ApiClient,
    palette: PaletteName,
) -> Result<VisitorColour, ApiError> {
    #[derive(Serialize)]
    struct Body {
        palette: PaletteName,
    }

    client
        .json(
            client
                .request(Method::PUT, &["api", "me", "colour"])
                .json(&Body { palette }),
        )
        .await
}

#[cfg(test)]
mod tests;
