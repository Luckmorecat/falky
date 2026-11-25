use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{fmt, str::FromStr};
use thiserror::Error;
use url::{Host, Url};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Origin {
    url: Url,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum OriginError {
    #[error("Enter a server origin such as https://falky.example.")]
    Invalid,
    #[error("Use HTTPS, or HTTP with localhost or 127.0.0.1.")]
    RequiresHttps,
}

impl Origin {
    pub fn parse(input: &str) -> Result<Self, OriginError> {
        let input = input.trim();
        let (_, remainder) = input.split_once("://").ok_or(OriginError::Invalid)?;
        let host_end = remainder.find(['/', '?', '#']).unwrap_or(remainder.len());
        let (authority, suffix) = remainder.split_at(host_end);
        if authority.is_empty()
            || authority.contains('@')
            || authority.ends_with(':')
            || !matches!(suffix, "" | "/")
            || input.contains('\\')
            || input.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(OriginError::Invalid);
        }

        let url = Url::parse(input).map_err(|_| OriginError::Invalid)?;
        if !url.has_host() {
            return Err(OriginError::Invalid);
        }
        match url.scheme() {
            "https" => {}
            "http" => {
                // URL parsing normalizes alternate numeric host spellings, such as 127.1.
                let host = authority.split(':').next().unwrap_or_default();
                if !host.eq_ignore_ascii_case("localhost") && host != "127.0.0.1" {
                    return Err(OriginError::RequiresHttps);
                }
            }
            _ => return Err(OriginError::RequiresHttps),
        }
        Ok(Self { url })
    }

    pub fn as_str(&self) -> &str {
        self.url.as_str().trim_end_matches('/')
    }

    pub fn contains_url(&self, url: &Url) -> bool {
        self.url.origin() == url.origin() && url.username().is_empty() && url.password().is_none()
    }

    pub(crate) fn is_loopback(&self) -> bool {
        match self.url.host() {
            Some(Host::Domain(host)) => host == "localhost",
            Some(Host::Ipv4(host)) => host.is_loopback(),
            Some(Host::Ipv6(host)) => host.is_loopback(),
            None => false,
        }
    }

    pub(crate) fn endpoint(&self, segments: &[&str]) -> Option<Url> {
        if segments.iter().any(|s| matches!(*s, "" | "." | "..")) {
            return None;
        }
        let mut url = self.url.clone();
        url.path_segments_mut()
            .ok()?
            .pop_if_empty()
            .extend(segments);
        Some(url)
    }
}

impl fmt::Display for Origin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Origin {
    type Err = OriginError;

    fn from_str(input: &str) -> Result<Self, Self::Err> {
        Self::parse(input)
    }
}

impl Serialize for Origin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Origin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let input = String::deserialize(deserializer)?;
        Self::parse(&input).map_err(serde::de::Error::custom)
    }
}
