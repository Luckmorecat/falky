#[allow(
    dead_code,
    reason = "cookie persistence is wired by the session module"
)]
pub(crate) mod credential;
mod origin;
#[cfg(test)]
mod tests;

use chrono::{DateTime, Utc};
use reqwest::cookie::{CookieStore, Jar};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, HeaderMap, HeaderValue, IF_NONE_MATCH, ORIGIN,
    PROXY_AUTHORIZATION, RETRY_AFTER, SET_COOKIE, USER_AGENT,
};
use reqwest::{Client, Response, StatusCode, multipart, redirect};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{sync::Arc, time::Duration};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Error as WebSocketError, client::IntoClientRequest, protocol::WebSocketConfig},
};

pub use origin::{Origin, OriginError};
pub use reqwest::Method;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const ERROR_BODY_LIMIT: usize = 8192;

pub type WebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

// Tungstenite traces upgrade headers and cookie_store debugs malformed cookies.
const _: () = assert!((log::STATIC_MAX_LEVEL as usize) <= (log::LevelFilter::Info as usize));

/// A single origin and cookie authority. Clones are valid for one session scope.
///
/// When a scope is retired, cancel its work and discard all its client clones.
/// Clearing a cookie cannot stop a pending response from updating the old jar.
#[derive(Clone)]
pub struct ApiClient {
    origin: Origin,
    origin_header: HeaderValue,
    client: Client,
    jar: Arc<Jar>,
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum ApiError {
    #[error("The request is invalid.")]
    InvalidRequest,
    #[error("Could not reach the Falky server.")]
    Transport,
    #[error("The Falky server returned an invalid response.")]
    InvalidResponse,
    #[error("The Falky server returned HTTP {status}.")]
    Http {
        status: StatusCode,
        code: Option<String>,
        retry_after: Option<Duration>,
    },
}

impl ApiError {
    pub fn status(&self) -> Option<StatusCode> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Http { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::Http { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status() == Some(StatusCode::UNAUTHORIZED)
    }
}

pub struct RequestBuilder(Result<reqwest::RequestBuilder, ApiError>);

impl RequestBuilder {
    pub fn query(self, query: &impl Serialize) -> Self {
        Self(self.0.map(|request| request.query(query)))
    }

    pub fn json(self, body: &impl Serialize) -> Self {
        Self(self.0.map(|request| request.json(body)))
    }

    pub fn empty_json(self) -> Self {
        self.json(&serde_json::json!({}))
    }

    pub fn multipart(self, form: multipart::Form) -> Self {
        Self(self.0.map(|request| request.multipart(form)))
    }

    pub fn if_none_match(self, etag: HeaderValue) -> Self {
        Self(self.0.map(|request| request.header(IF_NONE_MATCH, etag)))
    }

    pub fn timeout(self, timeout: Duration) -> Self {
        Self(self.0.map(|request| request.timeout(timeout)))
    }
}

impl ApiClient {
    pub fn new(origin: Origin) -> Result<Self, ApiError> {
        let jar = Arc::new(Jar::default());
        let origin_header =
            HeaderValue::from_str(origin.as_str()).map_err(|_| ApiError::InvalidRequest)?;
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, origin_header.clone());
        let builder = Client::builder()
            .user_agent(user_agent())
            .default_headers(headers)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(redirect::Policy::none())
            .retry(reqwest::retry::never())
            .cookie_provider(jar.clone());
        let builder = if origin.is_loopback() {
            builder.no_proxy()
        } else {
            builder
        };
        let client = builder.build().map_err(|_| ApiError::Transport)?;
        Ok(Self {
            origin,
            origin_header,
            client,
            jar,
        })
    }

    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    pub fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
        RequestBuilder(
            self.origin
                .endpoint(segments)
                .map(|url| self.client.request(method, url))
                .ok_or(ApiError::InvalidRequest),
        )
    }

    pub async fn send(&self, request: RequestBuilder) -> Result<Response, ApiError> {
        self.execute(request).await
    }

    pub async fn json<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T, ApiError> {
        let request = RequestBuilder(
            request
                .0
                .map(|request| request.header(ACCEPT, "application/json")),
        );
        self.execute(request).await?.json().await.map_err(|error| {
            if error.is_decode() {
                ApiError::InvalidResponse
            } else {
                ApiError::Transport
            }
        })
    }

    async fn execute(&self, request: RequestBuilder) -> Result<Response, ApiError> {
        let request = request.0?.build().map_err(|_| ApiError::InvalidRequest)?;
        if !self.origin.contains_url(request.url()) {
            return Err(ApiError::InvalidRequest);
        }
        let mut response = self
            .client
            .execute(request)
            .await
            .map_err(|_| ApiError::Transport)?;
        let status = response.status();
        if status.is_success() || status == StatusCode::NOT_MODIFIED {
            let headers = response.headers_mut();
            for credential in [SET_COOKIE, COOKIE, AUTHORIZATION, PROXY_AUTHORIZATION] {
                headers.remove(credential);
            }
            return Ok(response);
        }
        let retry_after = retry_after(response.headers());
        let mut body = Vec::new();
        if response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| h.split(';').next() == Some("application/json"))
        {
            while let Ok(Some(chunk)) = response.chunk().await {
                if body.len() + chunk.len() > ERROR_BODY_LIMIT {
                    body.clear();
                    break;
                }
                body.extend_from_slice(&chunk);
            }
        }
        Err(http_error(status, retry_after, &body))
    }

    pub async fn websocket(&self, segments: &[&str]) -> Result<WebSocket, ApiError> {
        let http_url = self
            .origin
            .endpoint(segments)
            .ok_or(ApiError::InvalidRequest)?;
        let mut socket_url = http_url.clone();
        let scheme = if http_url.scheme() == "http" {
            "ws"
        } else {
            "wss"
        };
        socket_url
            .set_scheme(scheme)
            .map_err(|_| ApiError::InvalidRequest)?;
        let mut request = socket_url
            .as_str()
            .into_client_request()
            .map_err(|_| ApiError::InvalidRequest)?;
        let headers = request.headers_mut();
        headers.insert(ORIGIN, self.origin_header.clone());
        headers.insert(USER_AGENT, HeaderValue::from_static(user_agent()));
        // An HttpOnly cookie is available for the HTTP upgrade URL, including its route path.
        if let Some(mut cookie) = self.jar.cookies(&http_url) {
            cookie.set_sensitive(true);
            headers.insert(COOKIE, cookie);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(1024 * 1024))
            .max_frame_size(Some(1024 * 1024));
        let result = tokio::time::timeout(
            CONNECT_TIMEOUT,
            connect_async_with_config(request, Some(config), false),
        )
        .await
        .map_err(|_| ApiError::Transport)?;
        match result {
            Ok((socket, _)) => Ok(socket),
            Err(WebSocketError::Http(response)) => Err(http_error(
                response.status(),
                retry_after(response.headers()),
                response.body().as_deref().unwrap_or_default(),
            )),
            Err(_) => Err(ApiError::Transport),
        }
    }
}

fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?;
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let expires = DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        (expires.with_timezone(&Utc) - Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

fn http_error(status: StatusCode, retry_after: Option<Duration>, body: &[u8]) -> ApiError {
    #[derive(Deserialize)]
    struct Body {
        code: String,
    }
    let code = if body.len() <= ERROR_BODY_LIMIT {
        serde_json::from_slice::<Body>(body)
            .ok()
            .map(|body| body.code)
            .filter(|code| {
                (1..=64).contains(&code.len())
                    && code
                        .bytes()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
            })
    } else {
        None
    };
    ApiError::Http {
        status,
        code,
        retry_after,
    }
}

fn user_agent() -> &'static str {
    if cfg!(target_os = "macos") {
        concat!("Falky/", env!("CARGO_PKG_VERSION"), " (Macintosh)")
    } else if cfg!(target_os = "windows") {
        concat!("Falky/", env!("CARGO_PKG_VERSION"), " (Windows)")
    } else if cfg!(target_os = "linux") {
        concat!("Falky/", env!("CARGO_PKG_VERSION"), " (Linux)")
    } else {
        concat!("Falky/", env!("CARGO_PKG_VERSION"))
    }
}
