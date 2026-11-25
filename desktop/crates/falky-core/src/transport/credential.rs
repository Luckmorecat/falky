use chrono::{DateTime, Utc};
use reqwest::cookie::CookieStore;
use url::Url;

use super::{ApiClient, Origin};
use crate::model::Secret;

const SESSION_COOKIE: &str = "falky_visitor";
const SIGN_IN_COOKIE: &str = "__Host-falky-signin";
const SESSION_PATH: &[&str] = &["api", "accounts", "session"];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionCredential {
    pub(crate) origin: Origin,
    pub(crate) secret: Secret,
}

impl ApiClient {
    pub(crate) fn session_cookie(&self) -> Option<SessionCredential> {
        let url = self.session_url();
        let header = self.jar.cookies(&url)?;
        let cookie = header.to_str().ok()?;
        cookie.split(';').find_map(|field| {
            let (name, value) = field.trim().split_once('=')?;
            (name == SESSION_COOKIE && !value.is_empty()).then(|| SessionCredential {
                origin: self.origin.clone(),
                secret: Secret::new(value.to_owned()),
            })
        })
    }

    pub(crate) fn restore_session_cookie(
        &self,
        credential: &SessionCredential,
        expires_at: DateTime<Utc>,
    ) -> bool {
        let value = credential.secret.expose_secret();
        if credential.origin != self.origin
            || value.is_empty()
            || value.len() > 256
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            return false;
        }
        let remaining = (expires_at - Utc::now()).num_seconds();
        if remaining <= 0 {
            return false;
        }
        let set_cookie = format!(
            "{SESSION_COOKIE}={value}; Path=/api; Max-Age={remaining}; Secure; HttpOnly; SameSite=Strict",
        );
        self.jar.add_cookie_str(&set_cookie, &self.session_url());
        true
    }

    pub(crate) fn clear_session_cookie(&self) {
        self.clear_cookie(SESSION_COOKIE, "/api");
    }

    pub(crate) fn clear_signin_cookie(&self) {
        self.clear_cookie(SIGN_IN_COOKIE, "/");
    }

    fn clear_cookie(&self, name: &str, path: &str) {
        self.jar.add_cookie_str(
            &format!("{name}=; Path={path}; Max-Age=0; Secure; HttpOnly; SameSite=Strict"),
            &self.session_url(),
        );
    }

    fn session_url(&self) -> Url {
        self.origin
            .endpoint(SESSION_PATH)
            .expect("the session endpoint is a static path")
    }
}
