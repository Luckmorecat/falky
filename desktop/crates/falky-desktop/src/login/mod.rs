mod view;

use std::time::{Duration, Instant};

use chrono::Utc;
use falky_core::{
    model::{AccountSession, SessionGeneration, SessionScope, SignInRequest, SignInState},
    session::{
        Authenticated, Candidate, Error, OriginStore, Qr, Restore, RestoreStatus, SignedOut,
    },
    transport::{ApiError, Origin, OriginError},
};
use iced::{Element, Subscription, Task, widget::qr_code};

use crate::ui_contract::Language;

const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub enum Message {
    OriginEdited(String),
    Connect,
    Retry,
    Cancel,
    ChangeServer,
    Tick,
    Completed(Box<Completion>),
    ExitReady,
}

#[derive(Clone, Debug)]
pub enum Outcome {
    SignedIn(AccountSession),
    ExitReady,
}

#[derive(Clone, Debug)]
pub struct Completion {
    scope: SessionScope,
    result: Result<Reply, Error>,
}

#[derive(Clone, Debug)]
enum Reply {
    Restore(RestoreStatus),
    Begun(Qr),
    Polled(SignInRequest),
    SignedIn(Box<Authenticated>),
    Cancelled,
    SignedOut(SignedOut),
    Revoked { storage_cleared: bool },
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Operation {
    Restore,
    Begin,
    Poll,
    Finish,
    Cancel,
    SignOut,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AfterCancel {
    Stay,
    ChangeServer,
    Exit,
}

#[derive(Clone, Copy)]
enum Notice {
    Revoked,
    MemoryOnly,
    LogoutUnconfirmed,
    CancelUnconfirmed,
}

struct Problem {
    error: Error,
    retry_at: Option<Instant>,
}

pub struct Login {
    store: OriginStore,
    input: String,
    invalid_origin: Option<OriginError>,
    origin_error: bool,
    candidate: Option<Candidate>,
    active: Option<Authenticated>,
    generation: u64,
    op: Option<Operation>,
    after_cancel: Option<AfterCancel>,
    request: Option<SignInRequest>,
    qr: Option<qr_code::Data>,
    problem: Option<Problem>,
    notice: Option<Notice>,
    next_poll: Instant,
    restore_failed: bool,
    resolve_delivery: bool,
    retry_cancel: bool,
    storage_error: bool,
}

impl Login {
    pub fn open() -> (Self, Task<Message>) {
        Self::open_with_store(OriginStore::default())
    }

    pub fn open_with_store(store: OriginStore) -> (Self, Task<Message>) {
        let remembered = store.load();
        let mut login = Self {
            store,
            input: String::new(),
            invalid_origin: None,
            origin_error: remembered.is_err(),
            candidate: None,
            active: None,
            generation: 0,
            op: None,
            after_cancel: None,
            request: None,
            qr: None,
            problem: None,
            notice: None,
            next_poll: Instant::now(),
            restore_failed: false,
            resolve_delivery: false,
            retry_cancel: false,
            storage_error: false,
        };
        let task = if let Ok(Some(origin)) = remembered {
            login.input = origin.to_string();
            login.enter(origin)
        } else {
            Task::none()
        };
        (login, task)
    }

    pub fn authenticated(&self) -> Option<&Authenticated> {
        self.active.as_ref()
    }

    /// The account surface can show this for authenticated memory-only sessions.
    pub fn storage_notice(&self, language: Language) -> Option<&'static str> {
        self.active
            .as_ref()
            .filter(|auth| !auth.remembered)
            .map(|_| view::session_in_memory(language))
    }

    pub fn subscription(&self) -> Subscription<Message> {
        if self.candidate.is_some() {
            iced::time::every(Duration::from_millis(500)).map(|_| Message::Tick)
        } else {
            Subscription::none()
        }
    }

    pub fn view(&self, language: Language) -> Element<'_, Message> {
        view::login(self, language)
    }

    pub fn update(&mut self, message: Message) -> (Task<Message>, Option<Outcome>) {
        let task = match message {
            Message::OriginEdited(value) => {
                self.input = value;
                self.invalid_origin = None;
                self.origin_error = false;
                Task::none()
            }
            Message::Connect if self.candidate.is_none() && self.active.is_none() => self.connect(),
            Message::Retry => self.retry(),
            Message::Cancel => self.cancel(AfterCancel::Stay),
            Message::ChangeServer => self.cancel(AfterCancel::ChangeServer),
            Message::Tick => self.tick(),
            Message::Completed(completion) => return self.completed(*completion),
            Message::ExitReady => return (Task::none(), Some(Outcome::ExitReady)),
            _ => Task::none(),
        };
        (task, None)
    }

    /// Immediately retires the local scope. The task uses its old client only
    /// for the bounded logout operation and opens the QR flow when it completes.
    pub fn sign_out(&mut self) -> Task<Message> {
        let Some(auth) = self.active.take() else {
            return Task::none();
        };
        self.return_to_qr(auth, None, |auth| async move {
            Reply::SignedOut(auth.sign_out().await)
        })
    }

    pub fn revoke(&mut self, scope: &SessionScope) -> Task<Message> {
        if self.active.as_ref().is_none_or(|auth| &auth.scope != scope) {
            return Task::none();
        }
        let auth = self.active.take().expect("the session scope matched");
        self.return_to_qr(auth, Some(Notice::Revoked), |auth| async move {
            Reply::Revoked {
                storage_cleared: auth.revoke().await,
            }
        })
    }

    pub fn exit(&mut self) -> Task<Message> {
        self.cancel(AfterCancel::Exit)
    }

    fn connect(&mut self) -> Task<Message> {
        let origin: Origin = match self.input.parse() {
            Ok(origin) => origin,
            Err(error) => {
                self.invalid_origin = Some(error);
                return Task::none();
            }
        };
        self.origin_error = self.store.save(&origin).is_err();
        self.input = origin.to_string();
        self.enter(origin)
    }

    fn enter(&mut self, origin: Origin) -> Task<Message> {
        self.storage_error = false;
        match Candidate::new(origin, self.next_generation()) {
            Ok(candidate) => self.candidate = Some(candidate),
            Err(error) => {
                self.set_problem(error);
                return Task::none();
            }
        }
        self.restore_failed = false;
        self.restore()
    }

    fn next_generation(&mut self) -> SessionGeneration {
        self.generation += 1;
        SessionGeneration(self.generation)
    }

    fn restore(&mut self) -> Task<Message> {
        let generation = self.next_generation();
        self.perform(Operation::Restore, move |candidate| async move {
            match candidate.restore(generation).await? {
                Restore::SignedOut(status) => Ok(Reply::Restore(status)),
                Restore::Account(auth) => Ok(Reply::SignedIn(auth)),
            }
        })
    }

    fn begin(&mut self, replace: bool) -> Task<Message> {
        self.perform(Operation::Begin, move |candidate| async move {
            candidate.begin(replace).await.map(Reply::Begun)
        })
    }

    fn tick(&mut self) -> Task<Message> {
        if self.op.is_some()
            || self.blocked()
            || !self.pending_qr()
            || Instant::now() < self.next_poll
        {
            return Task::none();
        }
        self.poll()
    }

    fn poll(&mut self) -> Task<Message> {
        let Some(request) = self.request.as_ref() else {
            return Task::none();
        };
        let id = request.id.clone();
        self.next_poll = Instant::now() + POLL_INTERVAL;
        self.perform(Operation::Poll, move |candidate| async move {
            candidate.poll(&id).await.map(Reply::Polled)
        })
    }

    fn finish(&mut self) -> Task<Message> {
        let Some(request) = self.request.as_ref() else {
            return Task::none();
        };
        let id = request.id.clone();
        let expires_at = request.expires_at;
        let generation = self.next_generation();
        self.perform(Operation::Finish, move |candidate| async move {
            let account = candidate.finish(&id, expires_at).await?;
            candidate
                .authenticate(account, generation)
                .await
                .map(|auth| Reply::SignedIn(Box::new(auth)))
        })
    }

    fn cancel(&mut self, next: AfterCancel) -> Task<Message> {
        if self.active.is_some() {
            return if next == AfterCancel::Exit {
                Task::done(Message::ExitReady)
            } else {
                Task::none()
            };
        }
        if self.after_cancel != Some(AfterCancel::Exit) {
            self.after_cancel = Some(next);
        }
        if self.op.is_some() {
            return Task::none();
        }
        if self.candidate.is_none() {
            return self.after_cancelled();
        }
        let id = self.request.as_ref().map(|request| request.id.clone());
        let generation = self.next_generation();
        self.perform(Operation::Cancel, move |candidate| async move {
            match candidate.cancel(id.as_ref()).await? {
                Some(account) => candidate
                    .authenticate(account, generation)
                    .await
                    .map(|auth| Reply::SignedIn(Box::new(auth))),
                None => Ok(Reply::Cancelled),
            }
        })
    }

    fn after_cancelled(&mut self) -> Task<Message> {
        let destination = self.after_cancel.take().unwrap_or(AfterCancel::Stay);
        let origin = self.candidate.take().map(|candidate| {
            candidate.retire();
            candidate.scope.origin
        });
        self.clear_qr();
        self.restore_failed = false;
        match destination {
            AfterCancel::Exit => Task::done(Message::ExitReady),
            AfterCancel::ChangeServer => {
                self.notice = None;
                Task::none()
            }
            AfterCancel::Stay => {
                if let Some(origin) = origin {
                    self.candidate = Candidate::new(origin, self.next_generation()).ok();
                }
                Task::none()
            }
        }
    }

    fn return_to_qr<F, Fut>(
        &mut self,
        auth: Authenticated,
        notice: Option<Notice>,
        finish: F,
    ) -> Task<Message>
    where
        F: FnOnce(Authenticated) -> Fut,
        Fut: Future<Output = Reply> + Send + 'static,
    {
        self.clear_qr();
        self.notice = notice;
        self.storage_error = false;
        match Candidate::new(auth.scope.origin.clone(), self.next_generation()) {
            Ok(candidate) => {
                let scope = candidate.scope.clone();
                self.candidate = Some(candidate);
                self.op = Some(Operation::SignOut);
                Task::perform(finish(auth), move |reply| {
                    Message::Completed(Box::new(Completion {
                        scope: scope.clone(),
                        result: Ok(reply),
                    }))
                })
            }
            Err(error) => {
                self.set_problem(error);
                // Always conclude the local/remote sign-out even if a fresh
                // HTTP client cannot be constructed.
                Task::perform(finish(auth), |_| Message::Tick)
            }
        }
    }

    fn perform<F, Fut>(&mut self, operation: Operation, work: F) -> Task<Message>
    where
        F: FnOnce(Candidate) -> Fut,
        Fut: Future<Output = Result<Reply, Error>> + Send + 'static,
    {
        if self.op.is_some() {
            return Task::none();
        }
        let Some(candidate) = self.candidate.clone() else {
            return Task::none();
        };
        let scope = candidate.scope.clone();
        self.op = Some(operation);
        self.problem = None;
        Task::perform(work(candidate), move |result| {
            Message::Completed(Box::new(Completion {
                scope: scope.clone(),
                result,
            }))
        })
    }

    fn retry(&mut self) -> Task<Message> {
        if self.op.is_some() || self.blocked() || self.active.is_some() {
            return Task::none();
        }
        if self.restore_failed {
            return self.restore();
        }
        if self.retry_cancel {
            return self.cancel(AfterCancel::Stay);
        }
        if self.binding_uncertain() {
            return self.begin(self.request.is_some());
        }
        if self.resolve_delivery || (self.finished_request() && !self.expired()) {
            return self.finish();
        }
        if self.pending_qr() {
            return self.poll();
        }
        if self
            .problem
            .as_ref()
            .is_some_and(|issue| issue.error == Error::Expired)
            && let Some(old) = self.candidate.take()
        {
            old.retire();
            self.clear_qr();
            match Candidate::new(old.scope.origin, self.next_generation()) {
                Ok(next) => self.candidate = Some(next),
                Err(error) => {
                    self.set_problem(error);
                    return Task::none();
                }
            }
        }
        self.begin(self.request.is_some())
    }

    fn completed(&mut self, completion: Completion) -> (Task<Message>, Option<Outcome>) {
        if self
            .candidate
            .as_ref()
            .is_none_or(|candidate| candidate.scope != completion.scope)
        {
            return (Task::none(), None);
        }
        let operation = self.op.take();
        let start_qr = match completion.result {
            Ok(Reply::SignedIn(_))
                if operation == Some(Operation::Restore)
                    && self.after_cancel == Some(AfterCancel::ChangeServer) =>
            {
                return (self.after_cancelled(), None);
            }
            Ok(Reply::SignedIn(auth)) => {
                let outcome = if self.after_cancel.take() == Some(AfterCancel::Exit) {
                    Outcome::ExitReady
                } else {
                    Outcome::SignedIn(auth.account.clone())
                };
                self.candidate = None;
                self.clear_qr();
                self.active = Some(*auth);
                return (Task::none(), Some(outcome));
            }
            Ok(Reply::Restore(status)) => {
                self.restore_failed = false;
                self.notice = match status {
                    RestoreStatus::Missing => None,
                    RestoreStatus::Expired => Some(Notice::Revoked),
                    RestoreStatus::StorageUnavailable => Some(Notice::MemoryOnly),
                };
                true
            }
            Ok(Reply::Begun(qr)) => {
                self.qr = qr_code::Data::new(qr.url.expose_secret().as_bytes()).ok();
                self.request = Some(qr.request);
                if self.qr.is_none() {
                    self.set_problem(Error::Api(ApiError::InvalidResponse));
                }
                self.next_poll = Instant::now() + POLL_INTERVAL;
                false
            }
            Ok(Reply::Polled(request)) => {
                if self
                    .request
                    .as_ref()
                    .is_none_or(|previous| previous.version <= request.version)
                {
                    self.request = Some(request);
                }
                self.next_poll = Instant::now() + POLL_INTERVAL;
                false
            }
            Ok(Reply::Cancelled) => return (self.after_cancelled(), None),
            Ok(Reply::SignedOut(result)) => {
                self.storage_error = !result.storage_cleared;
                self.notice = if !result.server_reached {
                    Some(Notice::LogoutUnconfirmed)
                } else {
                    None
                };
                true
            }
            Ok(Reply::Revoked { storage_cleared }) => {
                self.storage_error = !storage_cleared;
                true
            }
            Err(error) => {
                self.restore_failed = operation == Some(Operation::Restore);
                if operation == Some(Operation::Finish) {
                    self.resolve_delivery = match error {
                        Error::OutcomeUnknown => true,
                        Error::Expired => false,
                        _ => self.resolve_delivery,
                    };
                }
                if operation == Some(Operation::Cancel) {
                    if self.after_cancel != Some(AfterCancel::Stay) {
                        let task = self.after_cancelled();
                        self.notice = Some(Notice::CancelUnconfirmed);
                        return (task, None);
                    }
                    self.after_cancel = None;
                    self.retry_cancel = true;
                }
                self.set_problem(error);
                false
            }
        };

        let task = if let Some(after_cancel) = self.after_cancel {
            self.cancel(after_cancel)
        } else if start_qr {
            self.begin(false)
        } else if self.problem.is_none() && self.finished_request() && !self.expired() {
            self.finish()
        } else {
            Task::none()
        };
        (task, None)
    }

    fn clear_qr(&mut self) {
        self.request = None;
        self.qr = None;
        self.problem = None;
        self.resolve_delivery = false;
        self.retry_cancel = false;
    }

    fn set_problem(&mut self, error: Error) {
        let retry_at = match &error {
            Error::Api(error) => error
                .retry_after()
                .or_else(|| (error.code() == Some("rate_limited")).then_some(POLL_INTERVAL)),
            _ => None,
        }
        .and_then(|delay| Instant::now().checked_add(delay));
        self.problem = Some(Problem { error, retry_at });
    }

    fn blocked(&self) -> bool {
        self.problem
            .as_ref()
            .and_then(|problem| problem.retry_at)
            .is_some_and(|retry| Instant::now() < retry)
    }

    fn expired(&self) -> bool {
        self.request
            .as_ref()
            .is_some_and(|request| request.expires_at <= Utc::now())
    }

    fn pending_qr(&self) -> bool {
        !self.retry_cancel && !self.binding_uncertain() && !self.expired() && self.request.as_ref().is_some_and(|request| request.state == SignInState::Pending)
            && !self.problem.as_ref().is_some_and(|problem| matches!(&problem.error, Error::Api(error) if error.code() == Some("invalid_proof")))
    }

    fn binding_uncertain(&self) -> bool {
        self.candidate
            .as_ref()
            .is_some_and(Candidate::binding_uncertain)
    }

    fn finished_request(&self) -> bool {
        self.request.as_ref().is_some_and(|request| {
            matches!(request.state, SignInState::Approved | SignInState::Consumed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_candidate_results_leave_current_origin_and_operation_alone() {
        let config = tempfile::tempdir().unwrap();
        let (mut login, _) =
            Login::open_with_store(OriginStore::at(config.path().join("origin.json")));
        let origin: Origin = "http://localhost:9000".parse().unwrap();
        login.candidate = Some(Candidate::new(origin.clone(), SessionGeneration(2)).unwrap());
        login.op = Some(Operation::Begin);
        let (_, outcome) = login.update(Message::Completed(Box::new(Completion {
            scope: SessionScope {
                origin,
                generation: SessionGeneration(1),
            },
            result: Ok(Reply::Cancelled),
        })));
        assert!(outcome.is_none());
        assert_eq!(
            login.candidate.as_ref().unwrap().scope.generation,
            SessionGeneration(2)
        );
        assert!(login.op == Some(Operation::Begin));
    }
}
