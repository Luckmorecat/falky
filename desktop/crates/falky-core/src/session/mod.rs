mod storage;
#[cfg(test)]
mod tests;

use std::{
    fmt,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use thiserror::Error;
use url::Url;

use crate::{
    model::{
        AccountSession, Secret, SessionGeneration, SessionKind, SessionScope, SignInBegin,
        SignInKind, SignInRequest, SignInRequestId, SignInState,
    },
    transport::{ApiClient, ApiError, Method, Origin, credential::SessionCredential},
};

pub use storage::OriginStore;
use storage::{Keyring, SavedCredential};

const ACCOUNT_SESSION: &[&str] = &["api", "accounts", "session"];
const QR_SIGNINS: &[&str] = &["api", "accounts", "qr-signins"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const QR_TTL: chrono::Duration = chrono::Duration::minutes(5);

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum Error {
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error("This request has expired.")]
    Expired,
    #[error("Could not confirm sign-in. Retry the same request.")]
    OutcomeUnknown,
    #[error("Could not remember the server on this device.")]
    OriginStorage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RestoreStatus {
    Missing,
    Expired,
    StorageUnavailable,
}

#[derive(Clone, Debug)]
pub enum Restore {
    SignedOut(RestoreStatus),
    Account(Box<Authenticated>),
}

#[derive(Clone)]
pub struct Candidate {
    pub scope: SessionScope,
    client: ApiClient,
    binding: Arc<Mutex<Binding>>,
}

#[derive(Default)]
struct Binding {
    known: Option<(SignInRequestId, DateTime<Utc>)>,
    uncertain: Option<UncertainBinding>,
    consumed_cancel: Option<SignInRequestId>,
}

#[derive(Clone, Copy)]
struct UncertainBinding {
    lookup_before: Option<DateTime<Utc>>,
    possible_until: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct Qr {
    pub request: SignInRequest,
    pub url: Secret,
}

#[derive(Clone)]
pub struct Authenticated {
    pub scope: SessionScope,
    pub client: ApiClient,
    pub account: AccountSession,
    pub remembered: bool,
    credential: SessionCredential,
}

impl fmt::Debug for Authenticated {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Authenticated")
            .field("scope", &self.scope)
            .field("remembered", &self.remembered)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SignedOut {
    pub server_reached: bool,
    pub storage_cleared: bool,
}

impl Candidate {
    pub fn new(origin: Origin, generation: SessionGeneration) -> Result<Self, Error> {
        let client = ApiClient::new(origin.clone())?;
        Ok(Self {
            scope: SessionScope { origin, generation },
            client,
            binding: Arc::default(),
        })
    }

    pub async fn restore(&self, generation: SessionGeneration) -> Result<Restore, Error> {
        let origin = self.scope.origin.clone();
        let (credential, status) = match Keyring::load(origin.clone()).await {
            Ok(Some(credential)) => (credential, RestoreStatus::Expired),
            Ok(None) => return Ok(Restore::SignedOut(RestoreStatus::Missing)),
            Err(()) => return Ok(Restore::SignedOut(RestoreStatus::StorageUnavailable)),
        };
        let valid_cookie = self
            .client
            .restore_session_cookie(&credential.cookie, credential.expires_at);
        if valid_cookie {
            if let Some(account) = self.read_session().await? {
                let (mut auth, _) = self.promote(account, generation)?;
                // The saved slot may have changed while the server verified this cookie.
                auth.remembered = Keyring::load(origin)
                    .await
                    .is_ok_and(|saved| saved.is_some_and(|saved| saved.cookie == auth.credential));
                return Ok(Restore::Account(Box::new(auth)));
            }
            self.client.clear_session_cookie();
        }
        let status = if Keyring::forget(credential.cookie).await {
            status
        } else {
            RestoreStatus::StorageUnavailable
        };
        Ok(Restore::SignedOut(status))
    }

    pub async fn begin(&self, replace: bool) -> Result<Qr, Error> {
        if self
            .uncertain_binding()
            .is_some_and(|binding| self.can_lookup(binding))
        {
            match self.begin_request(false).await {
                Ok(result) => return self.confirm_qr(result),
                Err(error) if invalid_proof(&error) => {}
                Err(error) => return Err(error.into()),
            }
        }

        let started = Utc::now();
        let had_proof = self.client.has_signin_cookie();
        let result = match self.begin_request(replace).await {
            Err(error) if invalid_proof(&error) => self.begin_request(!replace).await,
            result => result,
        }
        .map_err(Error::from)
        .and_then(|result| self.confirm_qr(result));
        if matches!(&result, Err(Error::Api(error)) if uncertain(error)) {
            let mut binding = self.binding.lock().expect("candidate binding lock");
            let lookup_before = if !had_proof && self.client.has_signin_cookie() {
                // A newly received proof is returned only after allocation. The server
                // starts the five-minute QR lifetime at whole-second precision.
                Some(started + QR_TTL - chrono::Duration::seconds(1))
            } else {
                binding
                    .known
                    .as_ref()
                    .map(|(_, until)| *until)
                    .or(binding.uncertain.and_then(|prior| prior.lookup_before))
            };
            binding.uncertain = Some(UncertainBinding {
                lookup_before,
                possible_until: Utc::now() + QR_TTL,
            });
        }
        result
    }

    pub fn binding_uncertain(&self) -> bool {
        self.uncertain_binding().is_some()
    }

    fn uncertain_binding(&self) -> Option<UncertainBinding> {
        self.binding
            .lock()
            .expect("candidate binding lock")
            .uncertain
    }

    fn can_lookup(&self, binding: UncertainBinding) -> bool {
        // A begin(false) after expiry can allocate, even with a proof cookie.
        self.client.has_signin_cookie()
            && binding
                .lookup_before
                .is_some_and(|until| Utc::now() + REQUEST_TIMEOUT < until)
    }

    fn confirm_qr(&self, result: SignInBegin) -> Result<Qr, Error> {
        let url = result.url.ok_or(ApiError::InvalidResponse)?;
        let parsed = Url::parse(url.expose_secret()).map_err(|_| ApiError::InvalidResponse)?;
        if result.request.kind != SignInKind::Qr
            || result.request.id.as_str().is_empty()
            || !self.scope.origin.contains_url(&parsed)
            || parsed.path() != "/"
            || parsed.query().is_some()
            || !parsed
                .fragment()
                .and_then(|value| value.strip_prefix("qr-signin="))
                .is_some_and(|token| {
                    !token.is_empty()
                        && token.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
                        })
                })
        {
            return Err(ApiError::InvalidResponse.into());
        }
        *self.binding.lock().expect("candidate binding lock") = Binding {
            known: Some((result.request.id.clone(), result.request.expires_at)),
            ..Binding::default()
        };
        Ok(Qr {
            request: result.request,
            url,
        })
    }

    pub async fn poll(&self, id: &SignInRequestId) -> Result<SignInRequest, Error> {
        let request: SignInRequest = self
            .client
            .json(
                self.client
                    .request(
                        Method::GET,
                        &["api", "accounts", "signin-requests", id.as_str()],
                    )
                    .timeout(REQUEST_TIMEOUT),
            )
            .await?;
        if request.kind != SignInKind::Qr || &request.id != id {
            return Err(ApiError::InvalidResponse.into());
        }
        Ok(request)
    }

    pub async fn finish(
        &self,
        id: &SignInRequestId,
        deadline: DateTime<Utc>,
    ) -> Result<AccountSession, Error> {
        if let Some(actual) = self.read_session().await? {
            return Ok(actual);
        }
        if deadline <= Utc::now() {
            return Err(Error::Expired);
        }
        self.deliver(id).await
    }

    async fn deliver(&self, id: &SignInRequestId) -> Result<AccountSession, Error> {
        let delivered = self
            .client
            .json::<AccountSession>(
                self.client
                    .request(
                        Method::POST,
                        &["api", "accounts", "signin-requests", id.as_str(), "finish"],
                    )
                    .timeout(REQUEST_TIMEOUT)
                    .empty_json(),
            )
            .await;
        let expected = match delivered {
            Ok(account) => Some(account),
            Err(error) if uncertain(&error) || error.code() == Some("signin_conflict") => None,
            Err(error) => return Err(error.into()),
        };
        match self.read_session().await {
            Ok(Some(actual))
                if expected
                    .as_ref()
                    .is_none_or(|account| same_authority(account, &actual)) =>
            {
                Ok(actual)
            }
            _ => Err(Error::OutcomeUnknown),
        }
    }

    pub async fn cancel(
        &self,
        id: Option<&SignInRequestId>,
    ) -> Result<Option<AccountSession>, Error> {
        let (consumed_cancel, uncertain, known) = {
            let binding = self.binding.lock().expect("candidate binding lock");
            (
                binding.consumed_cancel.clone(),
                binding.uncertain,
                binding.known.clone(),
            )
        };
        if let Some(id) = consumed_cancel {
            return self.resolve_consumed_cancel(&id).await.map(Some);
        }
        let id = if let Some(binding) = uncertain {
            if self.client.session_cookie().is_some() {
                return self
                    .read_session()
                    .await
                    .ok()
                    .flatten()
                    .map(Some)
                    .ok_or(Error::OutcomeUnknown);
            }
            if binding.possible_until <= Utc::now() {
                return Ok(None);
            }
            if !self.can_lookup(binding) {
                return Err(Error::OutcomeUnknown);
            }
            let request = match self.begin_request(false).await {
                Ok(result)
                    if result.request.kind == SignInKind::Qr
                        && !result.request.id.as_str().is_empty() =>
                {
                    result.request
                }
                Err(error) if invalid_proof(&error) => return Ok(None),
                _ => return Err(Error::OutcomeUnknown),
            };
            *self.binding.lock().expect("candidate binding lock") = Binding {
                known: Some((request.id.clone(), request.expires_at)),
                ..Binding::default()
            };
            request.id
        } else if let Some(id) = known.map(|(id, _)| id).or_else(|| id.cloned()) {
            id
        } else {
            return Ok(None);
        };
        let result = self
            .client
            .send(
                self.client
                    .request(
                        Method::DELETE,
                        &["api", "accounts", "qr-signins", id.as_str()],
                    )
                    .timeout(REQUEST_TIMEOUT),
            )
            .await;
        match result {
            Ok(_) => Ok(None),
            Err(error) if error.status() == Some(StatusCode::CONFLICT) => {
                self.binding
                    .lock()
                    .expect("candidate binding lock")
                    .consumed_cancel = Some(id.clone());
                self.resolve_consumed_cancel(&id).await.map(Some)
            }
            Err(error) if invalid_proof(&error) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    async fn resolve_consumed_cancel(&self, id: &SignInRequestId) -> Result<AccountSession, Error> {
        if let Ok(Some(account)) = self.read_session().await {
            return Ok(account);
        }
        if !self.client.has_signin_cookie() {
            return Err(Error::OutcomeUnknown);
        }
        let request = self.poll(id).await.map_err(|_| Error::OutcomeUnknown)?;
        if request.state != SignInState::Consumed || request.expires_at <= Utc::now() {
            return Err(Error::OutcomeUnknown);
        }
        self.deliver(id).await.map_err(|_| Error::OutcomeUnknown)
    }

    pub async fn authenticate(
        &self,
        account: AccountSession,
        generation: SessionGeneration,
    ) -> Result<Authenticated, Error> {
        let (mut auth, expires_at) = self.promote(account, generation)?;
        auth.remembered = Keyring::save(SavedCredential {
            cookie: auth.credential.clone(),
            expires_at,
        })
        .await;
        Ok(auth)
    }

    fn promote(
        &self,
        account: AccountSession,
        generation: SessionGeneration,
    ) -> Result<(Authenticated, DateTime<Utc>), Error> {
        let expires_at = account_expiry(&account).ok_or(ApiError::InvalidResponse)?;
        let credential = self.client.session_cookie().ok_or(Error::OutcomeUnknown)?;
        let next = ApiClient::new(self.scope.origin.clone())?;
        if !next.restore_session_cookie(&credential, expires_at) {
            return Err(Error::OutcomeUnknown);
        }
        self.retire();
        Ok((
            Authenticated {
                scope: SessionScope {
                    origin: self.scope.origin.clone(),
                    generation,
                },
                client: next,
                account,
                remembered: false,
                credential,
            },
            expires_at,
        ))
    }

    pub fn retire(&self) {
        self.client.clear_session_cookie();
        self.client.clear_signin_cookie();
        *self.binding.lock().expect("candidate binding lock") = Binding::default();
    }

    async fn begin_request(&self, replace: bool) -> Result<SignInBegin, ApiError> {
        self.client
            .json(
                self.client
                    .request(Method::POST, QR_SIGNINS)
                    .timeout(REQUEST_TIMEOUT)
                    .json(&serde_json::json!({ "replace": replace })),
            )
            .await
    }

    async fn read_session(&self) -> Result<Option<AccountSession>, Error> {
        match account_session(&self.client).await {
            Err(error) if error.is_unauthorized() => Ok(None),
            Err(error) => Err(error.into()),
            Ok(account) if self.client.session_cookie().is_some() => Ok(Some(account)),
            Ok(_) => Err(ApiError::InvalidResponse.into()),
        }
    }
}

impl Authenticated {
    pub async fn sign_out(self) -> SignedOut {
        let result = self
            .client
            .send(
                self.client
                    .request(Method::POST, &["api", "accounts", "logout"])
                    .timeout(REQUEST_TIMEOUT)
                    .empty_json(),
            )
            .await;
        let server_reached = result.is_ok() || result.is_err_and(|error| error.is_unauthorized());
        SignedOut {
            server_reached,
            storage_cleared: self.revoke().await,
        }
    }

    pub async fn revoke(self) -> bool {
        self.client.clear_session_cookie();
        Keyring::forget(self.credential).await
    }
}

pub(crate) async fn account_session(client: &ApiClient) -> Result<AccountSession, ApiError> {
    let account = client
        .json(
            client
                .request(Method::GET, ACCOUNT_SESSION)
                .timeout(REQUEST_TIMEOUT),
        )
        .await?;
    if account_expiry(&account).is_none() {
        return Err(ApiError::InvalidResponse);
    }
    Ok(account)
}

fn account_expiry(account: &AccountSession) -> Option<DateTime<Utc>> {
    account
        .expires_at
        .filter(|expiry| account.kind == SessionKind::Account && *expiry > Utc::now())
}

fn same_authority(first: &AccountSession, second: &AccountSession) -> bool {
    first.kind == second.kind
        && first.visitor.id == second.visitor.id
        && first.expires_at == second.expires_at
}

fn uncertain(error: &ApiError) -> bool {
    matches!(error, ApiError::Transport | ApiError::InvalidResponse)
        || error
            .status()
            .is_some_and(|status| status.is_server_error())
}

fn invalid_proof(error: &ApiError) -> bool {
    error.status() == Some(StatusCode::FORBIDDEN) && error.code() == Some("invalid_proof")
}
