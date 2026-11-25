mod images;
#[cfg(test)]
mod tests;
mod view;

use std::{
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    future::Future,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use falky_core::{
    ApiClient, ApiError,
    attachments::{AttachmentsApi, Limits, is_available},
    chat::{
        Change, ChatApi, Page, Post, PreviousSync, ReadState, RoomSync, Stamp, Timeline, can_post,
        reply_of,
    },
    model::{
        Attachment, AttachmentId, LivePayload, LiveScope, LiveUpdate, Message as ChatMessage,
        MessageId, MessageReaction, MessageReply, ReconnectGeneration, RequestKey, Room, RoomId,
        SessionScope, Visitor, VisitorId,
    },
};
use futures_util::{StreamExt, TryStreamExt, stream};
use iced::{
    Event, Subscription, Task, event,
    task::Handle,
    widget::{Id, operation, scrollable, text_editor},
    window,
};

use crate::ui_contract::{Language, TickerItem};

use images::{Cache, ClipboardContents, Fetched, Input, InputError, Key, Size};

pub use view::message_summary;

const TICKER_DURATION: Duration = Duration::from_secs(6);
const MAX_TICKER: usize = 3;
const MAX_FETCHES: usize = 4;
const FEED: &str = "falky.chat.feed";
const COMPOSER: &str = "falky.chat.composer";

pub fn composer_id() -> Id {
    Id::new(COMPOSER)
}

pub struct Chat {
    scope: SessionScope,
    api: ApiClient,
    identity: Visitor,
    timeline: Timeline,
    read: ReadState,
    live: Option<LiveScope>,
    last_live: Option<ReconnectGeneration>,
    before_connect: HashMap<RoomId, PreviousSync>,
    open: bool,
    focused: bool,
    view_room: Option<RoomId>,
    new_after: Option<Option<MessageId>>,
    ticker: VecDeque<(ChatMessage, Instant)>,
    composers: HashMap<RoomId, Composer>,
    pending: HashMap<RoomId, Vec<Pending>>,
    scroll: HashMap<RoomId, f32>,
    scroll_anchors: HashMap<RoomId, view::FeedAnchor>,
    scroll_epoch: u64,
    view_width: f32,
    older: HashSet<RoomId>,
    syncing: HashSet<RoomId>,
    changing: HashSet<(RoomId, MessageId)>,
    modal: Option<Modal>,
    dropping: bool,
    limits: Limits,
    limits_loaded: bool,
    cache: Cache,
    visible: HashSet<Key>,
    validated: HashSet<Key>,
    image_errors: HashSet<Key>,
    fetching: HashMap<Key, Option<u64>>,
    jobs: HashMap<u64, Handle>,
    sequence: u64,
}

#[derive(Default)]
struct Composer {
    content: text_editor::Content,
    mode: Option<Compose>,
    drafts: Vec<Draft>,
    notice: Option<Notice>,
    importing: bool,
    queued_files: VecDeque<PathBuf>,
}

#[derive(Clone)]
enum Compose {
    Reply(MessageReply),
    Edit { id: MessageId, previous: String },
}

struct Draft {
    id: u64,
    name: String,
    preview: iced::widget::image::Handle,
    state: DraftState,
}

enum DraftState {
    Uploading(Input),
    Ready(Attachment),
    Failed(Input, ApiError),
}

struct Pending {
    payload: Post,
    reply: Option<MessageReply>,
    images: Vec<Draft>,
    error: Option<ApiError>,
}

#[derive(Clone, Debug)]
enum Notice {
    Input(InputError),
    TooMany,
    Change(Change),
    History,
}

enum Modal {
    Image(AttachmentId),
    Actions(MessageId),
    Delete(MessageId),
}

#[derive(Clone, Debug)]
pub enum Message {
    EditInput(text_editor::Action),
    Send,
    EditLast,
    Paste,
    Latest,
    Older,
    Scroll(RoomId, scrollable::Viewport),
    Actions(MessageId),
    Reply(MessageId),
    Edit(MessageId),
    AskDelete(MessageId),
    ConfirmDelete(MessageId),
    React(MessageId, MessageReaction),
    Copy(MessageId),
    CancelCompose,
    OpenImage(AttachmentId),
    RetryImage(AttachmentId),
    CloseModal,
    CloseChat,
    Pick,
    FileHovered,
    Dropped(PathBuf),
    DropLeft,
    RemoveDraft(u64),
    RetryDraft(u64),
    RetryPost(RequestKey),
    DiscardPost(RequestKey),
    OpenLink(String),
    Tick,
    Measured(RoomId, u64, view::Measured),
    Finished(u64, SessionScope, Box<Work>),
    RetrySync(LiveScope, RoomId),
}

#[derive(Clone, Debug)]
pub enum Work {
    Limits(Result<Limits, ApiError>),
    Sync(LiveScope, RoomId, Stamp, Result<RoomSync, ApiError>),
    Older(RoomId, Stamp, Result<Page, ApiError>),
    Post(RoomId, Stamp, RequestKey, Result<ChatMessage, ApiError>),
    Change(
        RoomId,
        Stamp,
        MessageId,
        Change,
        Result<ChatMessage, ApiError>,
    ),
    Input(RoomId, Vec<Result<Input, InputError>>),
    Picked(RoomId, Option<Vec<PathBuf>>),
    Paste(RoomId, ClipboardContents),
    Uploaded(RoomId, u64, Result<Attachment, ApiError>),
    Cancelled(Result<(), ApiError>),
    Metadata(LiveScope, MetadataResult),
    Image(u64, Key, Result<Fetched, ApiError>),
}

type MetadataResult = Result<Vec<(AttachmentId, Result<Attachment, ApiError>)>, ApiError>;

impl Work {
    fn live_scope(&self) -> Option<&LiveScope> {
        match self {
            Self::Sync(scope, ..) | Self::Metadata(scope, _) => Some(scope),
            _ => None,
        }
    }

    fn error(&self) -> Option<&ApiError> {
        match self {
            Self::Limits(result) => result.as_ref().err(),
            Self::Sync(_, _, _, result) => result.as_ref().err(),
            Self::Older(_, _, result) => result.as_ref().err(),
            Self::Post(_, _, _, result) | Self::Change(_, _, _, _, result) => result.as_ref().err(),
            Self::Uploaded(_, _, result) => result.as_ref().err(),
            Self::Cancelled(result) => result.as_ref().err(),
            Self::Metadata(_, result) => result.as_ref().err(),
            Self::Image(_, _, result) => result.as_ref().err(),
            _ => None,
        }
    }
}

pub struct LiveResult {
    pub fresh: Option<ChatMessage>,
    pub task: Task<Message>,
}

pub struct Update {
    pub task: Task<Message>,
    pub unauthorized: Option<SessionScope>,
    pub close: bool,
}

impl Default for Update {
    fn default() -> Self {
        Self {
            task: Task::none(),
            unauthorized: None,
            close: false,
        }
    }
}

impl Chat {
    pub fn new(scope: SessionScope, api: ApiClient, identity: Visitor, read: ReadState) -> Self {
        Self {
            scope,
            api,
            identity,
            timeline: Timeline::default(),
            read,
            live: None,
            last_live: None,
            before_connect: HashMap::new(),
            open: false,
            focused: false,
            view_room: None,
            new_after: None,
            ticker: VecDeque::new(),
            composers: HashMap::new(),
            pending: HashMap::new(),
            scroll: HashMap::new(),
            scroll_anchors: HashMap::new(),
            scroll_epoch: 0,
            view_width: 222.0,
            older: HashSet::new(),
            syncing: HashSet::new(),
            changing: HashSet::new(),
            modal: None,
            dropping: false,
            limits: Limits::default(),
            limits_loaded: false,
            cache: Cache::default(),
            visible: HashSet::new(),
            validated: HashSet::new(),
            image_errors: HashSet::new(),
            fetching: HashMap::new(),
            jobs: HashMap::new(),
            sequence: 0,
        }
    }

    pub fn update_identity(&mut self, visitor: Visitor) {
        if self.identity.id == visitor.id {
            self.identity = visitor;
        }
    }

    pub fn read_state(&self) -> &ReadState {
        &self.read
    }

    pub fn begin_reconnect(&mut self, scope: &LiveScope) {
        if scope.session != self.scope
            || self
                .last_live
                .is_some_and(|last| last.0 >= scope.generation.0)
        {
            return;
        }
        self.before_connect = self.timeline.begin_reconnect();
        self.invalidate_image_revalidation();
        self.syncing.clear();
        self.last_live = Some(scope.generation);
        self.live = Some(scope.clone());
    }

    pub fn invalidate_live(&mut self) {
        self.invalidate_image_revalidation();
        self.live = None;
        self.before_connect.clear();
        self.syncing.clear();
    }

    pub fn sync_after(&mut self, scope: &LiveScope, rooms: &[Room]) -> Task<Message> {
        if self.live.as_ref() != Some(scope) {
            return Task::none();
        }
        let mut tasks = rooms
            .iter()
            .map(|room| self.sync_room(scope.clone(), room.id.clone()))
            .collect::<Vec<_>>();
        if !self.limits_loaded {
            let api = AttachmentsApi(self.api.clone());
            tasks.push(self.work(async move { Work::Limits(api.limits().await) }));
        }
        Task::batch(tasks)
    }

    fn sync_room(&mut self, scope: LiveScope, room: RoomId) -> Task<Message> {
        if self.live.as_ref() != Some(&scope) || !self.syncing.insert(room.clone()) {
            return Task::none();
        }
        let previous = self.before_connect.get(&room).cloned().unwrap_or_default();
        let stamp = self.timeline.request_stamp();
        let api = ChatApi(self.api.clone());
        self.work(async move {
            let result = api.sync(&room, previous).await;
            Work::Sync(scope, room, stamp, result)
        })
    }

    pub fn refresh_attachments(&mut self, scope: &LiveScope) -> Task<Message> {
        if self.live.as_ref() != Some(scope) {
            return Task::none();
        }
        self.invalidate_image_revalidation();
        let ids = self
            .timeline
            .available_attachments()
            .map(|a| a.id.clone())
            .collect::<HashSet<_>>();
        let api = AttachmentsApi(self.api.clone());
        let scope = scope.clone();
        self.work(async move {
            let results = stream::iter(ids)
                .map(|id| {
                    let api = api.clone();
                    async move {
                        let result = api.metadata(&id).await;
                        if let Err(error) = &result
                            && error.is_unauthorized()
                        {
                            return Err(error.clone());
                        }
                        Ok((id, result))
                    }
                })
                .buffer_unordered(MAX_FETCHES)
                .try_collect()
                .await;
            Work::Metadata(scope, results)
        })
    }

    pub fn on_live(&mut self, update: &LiveUpdate) -> LiveResult {
        let mut result = LiveResult {
            fresh: None,
            task: Task::none(),
        };
        if self.live.as_ref() != Some(&update.scope) {
            return result;
        }
        let event = &update.event;
        match &event.payload {
            LivePayload::MessageCreated(message) | LivePayload::MessageUpdated(message) => {
                let created = matches!(event.payload, LivePayload::MessageCreated(_));
                let deletion = self.message_deletion(message);
                let fresh = self
                    .timeline
                    .live(event.event_id.clone(), message.clone(), created);
                self.apply_message_deletion(deletion);
                if fresh && message.author_id != self.identity.id {
                    if !self.open && self.view_room.as_ref() == Some(&message.room_id) {
                        self.ticker.push_back((message.clone(), Instant::now()));
                        while self.ticker.len() > MAX_TICKER {
                            self.ticker.pop_front();
                        }
                    }
                    result.fresh = Some(message.clone());
                }
                self.sync_read();
                result.task = self.measure();
            }
            LivePayload::AttachmentsExpired(expired) => {
                self.expire(expired.attachment_ids.clone());
            }
            LivePayload::RoomChanged(room) if self.timeline.room(&room.id).is_none() => {
                result.task = self.sync_room(update.scope.clone(), room.id.clone());
            }
            _ => {}
        }
        result
    }

    pub fn select_room(&mut self, room: Option<RoomId>) -> Task<Message> {
        if self.view_room == room {
            return Task::none();
        }
        if let Some(room) = &room {
            self.composers.entry(room.clone()).or_default();
        }
        self.view_room = room.clone();
        self.read.viewed_room = room;
        self.reset_display();
        self.open_reading();
        self.restore_scroll().chain(self.measure())
    }

    pub fn set_open(&mut self, open: bool) -> Task<Message> {
        if self.open == open {
            return Task::none();
        }
        self.open = open;
        self.reset_display();
        self.open_reading();
        if open {
            self.restore_scroll().chain(self.measure())
        } else {
            Task::none()
        }
    }

    pub fn set_focused(&mut self, focused: bool) -> Task<Message> {
        self.focused = focused;
        self.sync_read();
        Task::none()
    }

    pub fn focus(&self) -> Task<Message> {
        operation::focus(composer_id())
    }

    pub fn modal_open(&self) -> bool {
        self.modal.is_some()
    }

    pub fn relevant_visitors(&self) -> BTreeSet<VisitorId> {
        let mut visitors = BTreeSet::new();
        for message in self.timeline.messages() {
            visitors.insert(message.author_id.clone());
            for reaction in &message.reactions {
                visitors.extend(reaction.visitor_ids.iter().cloned());
            }
        }
        visitors
    }

    pub fn unread(&self, id: &RoomId) -> usize {
        self.timeline.room(id).map_or(0, |room| {
            room.unread(
                self.read.last_read.get(id).and_then(Option::as_ref),
                &self.identity.id,
            )
        })
    }

    pub fn ticker(&self, language: Language) -> Vec<TickerItem> {
        self.ticker_messages()
            .map(|message| TickerItem {
                author: message.author_name.clone(),
                summary: message_summary(message, language),
            })
            .collect()
    }

    pub fn ticker_visitors(&self) -> Vec<VisitorId> {
        self.ticker_messages()
            .map(|message| message.author_id.clone())
            .collect()
    }

    fn ticker_messages(&self) -> impl Iterator<Item = &ChatMessage> {
        self.ticker
            .iter()
            .filter(|(_, added)| added.elapsed() < TICKER_DURATION)
            .map(|(message, _)| message)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        let drops = if self.open {
            event::listen_with(|event, _, _| match event {
                Event::Window(window::Event::FileHovered(_)) => Some(Message::FileHovered),
                Event::Window(window::Event::FileDropped(path)) => Some(Message::Dropped(path)),
                Event::Window(window::Event::FilesHoveredLeft) => Some(Message::DropLeft),
                _ => None,
            })
        } else {
            Subscription::none()
        };
        let clock = if self.ticker.is_empty() {
            Subscription::none()
        } else {
            iced::time::every(Duration::from_millis(125)).map(|_| Message::Tick)
        };
        let escape = if self.modal_open() {
            event::listen_with(|event, _, _| match event {
                Event::Keyboard(iced::keyboard::Event::KeyPressed {
                    key: iced::keyboard::Key::Named(iced::keyboard::key::Named::Escape),
                    ..
                }) => Some(Message::CloseModal),
                _ => None,
            })
        } else {
            Subscription::none()
        };
        Subscription::batch([drops, clock, escape])
    }

    pub fn update(&mut self, message: Message) -> Update {
        let mut update = Update::default();
        update.task = match message {
            Message::Finished(job, scope, work) => {
                if scope != self.scope {
                    return update;
                }
                self.jobs.remove(&job);
                if work.error().is_some_and(ApiError::is_unauthorized) {
                    update.unauthorized = Some(scope);
                    return update;
                }
                if work
                    .live_scope()
                    .is_some_and(|live| self.live.as_ref() != Some(live))
                {
                    return update;
                }
                self.finish(*work)
            }
            Message::CloseChat => {
                update.close = true;
                Task::none()
            }
            Message::CloseModal => self.close_modal(),
            Message::OpenLink(url) => {
                if url::Url::parse(&url)
                    .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
                {
                    let _ = open::that_detached(url);
                }
                Task::none()
            }
            Message::Tick => {
                self.ticker
                    .retain(|(_, added)| added.elapsed() < TICKER_DURATION);
                Task::none()
            }
            Message::RetrySync(scope, room) => self.sync_room(scope, room),
            Message::Measured(room, epoch, measured) if epoch == self.scroll_epoch => {
                self.measured(&room, measured)
            }
            Message::FileHovered => {
                self.dropping = self.open;
                Task::none()
            }
            Message::DropLeft => {
                self.dropping = false;
                Task::none()
            }
            message => self.current_room_message(message),
        };
        update
    }

    fn current_room_message(&mut self, message: Message) -> Task<Message> {
        let Some(room) = self.view_room.clone() else {
            return Task::none();
        };
        match message {
            Message::EditInput(action) => {
                let composer = self.composers.entry(room).or_default();
                composer.content.perform(action);
                Task::none()
            }
            Message::Send => self.post_current(room),
            Message::EditLast => {
                let last = self.timeline.room(&room).and_then(|timeline| {
                    timeline
                        .messages()
                        .rev()
                        .find(|message| message.author_id == self.identity.id && !message.deleted)
                });
                if let Some(last) = last {
                    self.compose_edit(room, last.id.clone())
                } else {
                    Task::none()
                }
            }
            Message::Paste => {
                let bytes = self.limits.input_bytes;
                self.work(async move { Work::Paste(room, images::paste(bytes).await) })
            }
            Message::Latest => {
                self.scroll.remove(&room);
                self.scroll_anchors.remove(&room);
                self.scroll_epoch += 1;
                self.sync_read();
                self.restore_scroll().chain(self.measure())
            }
            Message::Older => self.load_older(room),
            Message::Scroll(target, viewport) if target == room => {
                self.view_width = viewport.bounds().width - 55.0;
                let offset = viewport.absolute_offset().y;
                let at_top = viewport.absolute_offset_reversed().y <= 12.0;
                let offset = if offset <= 48.0 { 0.0 } else { offset };
                let previous = self.scroll.insert(room.clone(), offset).unwrap_or_default();
                if (offset - previous).abs() > 1.0 {
                    self.scroll_anchors.remove(&room);
                    self.scroll_epoch += 1;
                }
                self.sync_read();
                if at_top && offset > 48.0 {
                    return Task::batch([self.load_older(room), self.measure()]);
                }
                self.measure()
            }
            Message::Actions(id) => {
                self.modal = Some(Modal::Actions(id));
                Task::none()
            }
            Message::Reply(id) => {
                self.modal = None;
                let original = self.timeline.room(&room).and_then(|r| r.get(&id));
                if let Some(message) = original.filter(|m| !m.deleted) {
                    let reply = reply_of(message);
                    self.cancel_compose(&room);
                    self.composers.entry(room).or_default().mode = Some(Compose::Reply(reply));
                    return self.focus();
                }
                Task::none()
            }
            Message::Edit(id) => self.compose_edit(room, id),
            Message::CancelCompose => {
                self.cancel_compose(&room);
                self.focus()
            }
            Message::Copy(id) => {
                let body = self
                    .timeline
                    .room(&room)
                    .and_then(|r| r.get(&id))
                    .map(|m| m.body.clone());
                self.modal = None;
                body.map_or_else(Task::none, iced::clipboard::write)
            }
            Message::AskDelete(id) => {
                self.modal = Some(Modal::Delete(id));
                Task::none()
            }
            Message::ConfirmDelete(id) => {
                if matches!(&self.modal, Some(Modal::Delete(target)) if target == &id) {
                    self.modal = None;
                    return self.change(room, id, Change::Delete);
                }
                Task::none()
            }
            Message::React(id, reaction) => {
                self.modal = None;
                let message = self.timeline.room(&room).and_then(|r| r.get(&id));
                if let Some(message) = message {
                    let active = message.reactions.iter().any(|group| {
                        group.reaction == reaction && group.visitor_ids.contains(&self.identity.id)
                    });
                    return self.change(room, id, Change::Reaction(reaction, !active));
                }
                Task::none()
            }
            Message::OpenImage(id) => self.open_image(&room, id),
            Message::RetryImage(id) => {
                for size in [Size::Thumbnail, Size::Viewer] {
                    self.image_errors.remove(&Key(id.clone(), size));
                }
                self.fetch_visible()
            }
            Message::Pick => self.pick(room),
            Message::Dropped(path) if self.open => {
                self.dropping = false;
                self.import(room, vec![path])
            }
            Message::RemoveDraft(id) => self.remove_draft(&room, id),
            Message::RetryDraft(id) => self.retry_draft(room, id),
            Message::RetryPost(key) => self.retry_post(room, key),
            Message::DiscardPost(key) => self.discard_post(&room, &key),
            _ => Task::none(),
        }
    }

    fn finish(&mut self, work: Work) -> Task<Message> {
        match work {
            Work::Limits(Ok(limits)) => {
                self.limits = limits;
                self.limits_loaded = true;
            }
            Work::Sync(scope, room, stamp, result) => {
                self.syncing.remove(&room);
                if let Ok(sync) = result {
                    return self.merge_sync(room, stamp, sync);
                }
                if let Err(error) = &result
                    && (error.status().is_none()
                        || error.status().is_some_and(|s| s.is_server_error()))
                {
                    return self.work_retry(scope, room);
                }
                self.composers.entry(room).or_default().notice = Some(Notice::History);
            }
            Work::Older(room, stamp, result) => {
                self.older.remove(&room);
                match result {
                    Ok(page) => {
                        self.merge_messages(stamp, page.messages, true);
                        self.timeline.room_mut(room).has_older = page.full;
                        return self.measure();
                    }
                    Err(_) => {
                        self.composers.entry(room).or_default().notice = Some(Notice::History)
                    }
                }
            }
            Work::Post(room, stamp, key, result) => {
                let pending = self.pending.entry(room).or_default();
                match result {
                    Ok(message) => {
                        pending.retain(|p| p.payload.request_key != key);
                        self.merge_messages(stamp, [message], true);
                        self.sync_read();
                    }
                    Err(error) => {
                        if let Some(post) =
                            pending.iter_mut().find(|p| p.payload.request_key == key)
                        {
                            post.error = Some(error);
                        }
                    }
                }
                return self.measure();
            }
            Work::Change(room, stamp, id, change, result) => {
                self.changing.remove(&(room.clone(), id.clone()));
                match result {
                    Ok(message) => self.merge_messages(stamp, [message], false),
                    Err(_) => {
                        self.composers.entry(room).or_default().notice =
                            Some(Notice::Change(change))
                    }
                }
                return self.measure();
            }
            Work::Input(room, inputs) => {
                let composer = self.composers.entry(room.clone()).or_default();
                composer.importing = false;
                let queued = composer.queued_files.drain(..).collect::<Vec<_>>();
                let uploads = self.add_inputs(room.clone(), inputs);
                return Task::batch([uploads, self.import(room, queued)]);
            }
            Work::Picked(room, Some(paths)) => return self.import(room, paths),
            Work::Paste(room, contents) => match contents {
                ClipboardContents::Text(text) => {
                    self.composers.entry(room).or_default().content.perform(
                        text_editor::Action::Edit(text_editor::Edit::Paste(Arc::new(text))),
                    );
                }
                ClipboardContents::Image(input) => return self.add_inputs(room, vec![input]),
                ClipboardContents::Unavailable => {}
            },
            Work::Uploaded(room, id, result) => return self.finish_upload(room, id, result),
            Work::Metadata(_, Ok(results)) => {
                for (id, result) in results {
                    match result {
                        Ok(attachment) => {
                            self.timeline.attachment_metadata(attachment);
                            if self.timeline.is_expired(&id) {
                                self.expire(vec![id]);
                            }
                        }
                        Err(error) if error.status() == Some(reqwest::StatusCode::NOT_FOUND) => {
                            self.expire(vec![id]);
                        }
                        Err(_) => {}
                    }
                }
                self.validated.clear();
                self.image_errors.clear();
                return self.measure().chain(self.fetch_visible());
            }
            Work::Image(generation, key, result) => {
                return self.finish_image(generation, key, result);
            }
            _ => {}
        }
        Task::none()
    }

    fn merge_sync(&mut self, room_id: RoomId, stamp: Stamp, sync: RoomSync) -> Task<Message> {
        if sync.initial && !self.read.last_read.contains_key(&room_id) {
            let first_live = self
                .timeline
                .room(&room_id)
                .and_then(|r| r.first_live.as_ref());
            let known = sync
                .newer
                .iter()
                .filter(|m| first_live.is_none_or(|live| m.id < *live))
                .map(|m| &m.id)
                .max()
                .cloned();
            self.read.mark(room_id.clone(), known);
        }
        self.merge_messages(stamp, sync.existing, false);
        self.merge_messages(stamp, sync.newer, true);
        let room = self.timeline.room_mut(room_id);
        if sync.initial {
            room.has_older = sync.has_older;
        }
        room.loaded = true;
        room.finish_sync();
        self.sync_read();
        self.measure()
    }

    fn work_retry(&self, scope: LiveScope, room: RoomId) -> Task<Message> {
        Task::perform(
            async { tokio::time::sleep(Duration::from_secs(3)).await },
            move |()| Message::RetrySync(scope.clone(), room.clone()),
        )
    }

    fn work(&mut self, future: impl Future<Output = Work> + Send + 'static) -> Task<Message> {
        let scope = self.scope.clone();
        let job = self.next_id();
        let (task, handle) = Task::perform(future, move |work| {
            Message::Finished(job, scope.clone(), Box::new(work))
        })
        .abortable();
        self.jobs.insert(job, handle.abort_on_drop());
        task
    }

    fn next_id(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    fn open_reading(&mut self) {
        if let Some(room) = &self.view_room
            && self.open
            && self.unread(room) > 0
        {
            self.new_after = Some(self.read.last_read.get(room).cloned().flatten());
        }
        self.sync_read();
    }

    fn sync_read(&mut self) {
        if let Some(room) = &self.view_room
            && self.open
            && self.focused
            && self.scroll.get(room).copied().unwrap_or_default() <= 48.0
            && let Some(timeline) = self.timeline.room(room).filter(|r| r.loaded)
        {
            let newest = timeline.messages().next_back().map(|m| m.id.clone());
            self.read.mark(room.clone(), newest);
        }
    }

    fn restore_scroll(&self) -> Task<Message> {
        let offset = self
            .view_room
            .as_ref()
            .and_then(|room| self.scroll.get(room))
            .copied()
            .unwrap_or_default();
        operation::scroll_to(
            FEED,
            operation::AbsoluteOffset {
                x: None,
                y: Some(offset),
            },
        )
    }

    fn reset_display(&mut self) {
        self.scroll_epoch += 1;
        self.new_after = None;
        self.ticker.clear();
        self.modal = None;
        self.dropping = false;
        self.visible.clear();
        self.invalidate_image_revalidation();
    }

    fn load_older(&mut self, room: RoomId) -> Task<Message> {
        let oldest = self
            .timeline
            .room(&room)
            .filter(|r| r.has_older)
            .and_then(|r| r.messages().next())
            .map(|message| message.id.clone());
        let Some(oldest) = oldest else {
            return Task::none();
        };
        if !self.older.insert(room.clone()) {
            return Task::none();
        }
        self.composers.entry(room.clone()).or_default().notice = None;
        let stamp = self.timeline.request_stamp();
        let api = ChatApi(self.api.clone());
        self.work(async move {
            let result = api.older(&room, &oldest).await;
            Work::Older(room, stamp, result)
        })
    }

    fn cancel_compose(&mut self, room: &RoomId) {
        if let Some(composer) = self.composers.get_mut(room)
            && let Some(Compose::Edit { previous, .. }) = composer.mode.take()
        {
            composer.content = text_editor::Content::with_text(&previous);
        }
    }

    fn cancel_deleted_target(&mut self, room: &RoomId, id: &MessageId) {
        let composing = self.composers.get(room).and_then(|c| c.mode.as_ref());
        if matches!(composing, Some(Compose::Edit { id: target, .. }) if target == id)
            || matches!(composing, Some(Compose::Reply(reply)) if &reply.id == id)
        {
            self.cancel_compose(room);
        }
    }

    fn message_deletion(
        &self,
        message: &ChatMessage,
    ) -> Option<(RoomId, MessageId, Vec<AttachmentId>)> {
        if !message.deleted {
            return None;
        }
        let attachments = self
            .timeline
            .room(&message.room_id)
            .and_then(|room| room.get(&message.id))
            .into_iter()
            .flat_map(|prior| &prior.attachments)
            .map(|attachment| attachment.id.clone())
            .collect();
        Some((message.room_id.clone(), message.id.clone(), attachments))
    }

    fn apply_message_deletion(&mut self, deletion: Option<(RoomId, MessageId, Vec<AttachmentId>)>) {
        if let Some((room, id, removed)) = deletion
            && self
                .timeline
                .room(&room)
                .and_then(|timeline| timeline.get(&id))
                .is_some_and(|current| current.deleted)
        {
            self.expire(removed);
            self.cancel_deleted_target(&room, &id);
        }
    }

    fn merge_messages(
        &mut self,
        stamp: Stamp,
        messages: impl IntoIterator<Item = ChatMessage>,
        insert: bool,
    ) {
        for message in messages {
            let deletion = self.message_deletion(&message);
            self.timeline.merge_http(stamp, [message], insert);
            self.apply_message_deletion(deletion);
        }
    }

    fn compose_edit(&mut self, room: RoomId, id: MessageId) -> Task<Message> {
        let message = self.timeline.room(&room).and_then(|r| r.get(&id));
        let Some(body) = message
            .filter(|m| !m.deleted && m.author_id == self.identity.id)
            .map(|m| m.body.clone())
        else {
            return Task::none();
        };
        self.cancel_compose(&room);
        let composer = self.composers.entry(room).or_default();
        composer.mode = Some(Compose::Edit {
            id,
            previous: composer.content.text(),
        });
        composer.content = text_editor::Content::with_text(&body);
        composer
            .content
            .perform(text_editor::Action::Move(text_editor::Motion::DocumentEnd));
        self.modal = None;
        self.focus()
    }

    fn post_current(&mut self, room: RoomId) -> Task<Message> {
        let composer = self.composers.entry(room.clone()).or_default();
        let body = composer.content.text();
        if let Some(Compose::Edit { id, .. }) = &composer.mode {
            let id = id.clone();
            if self.changing.contains(&(room.clone(), id.clone())) {
                return Task::none();
            }
            let original = self.timeline.room(&room).and_then(|r| r.get(&id));
            if let Some(message) = original.filter(|m| {
                !m.deleted
                    && m.author_id == self.identity.id
                    && can_post(&body, m.attachments.len())
            }) {
                let changed = message.body != body;
                self.cancel_compose(&room);
                if changed {
                    return self.change(room, id, Change::Edit(body));
                }
            }
            return Task::none();
        }
        let ready = composer
            .drafts
            .iter()
            .filter(|d| matches!(d.state, DraftState::Ready(_)))
            .count();
        if !can_post(&body, ready)
            || composer.importing
            || composer
                .drafts
                .iter()
                .any(|d| matches!(d.state, DraftState::Uploading(_)))
        {
            return Task::none();
        }
        let reply = match composer.mode.take() {
            Some(Compose::Reply(reply)) => Some(reply),
            _ => None,
        };
        let mut images = Vec::new();
        let mut ids = Vec::new();
        composer.drafts.retain(|d| {
            if let DraftState::Ready(attachment) = &d.state {
                ids.push(attachment.id.clone());
                let state = DraftState::Ready(attachment.clone());
                images.push(Draft {
                    id: d.id,
                    name: d.name.clone(),
                    preview: d.preview.clone(),
                    state,
                });
                false
            } else {
                true
            }
        });
        let payload = Post::new(body, ids, reply.as_ref().map(|reply| reply.id.clone()));
        composer.content = text_editor::Content::new();
        composer.notice = None;
        self.pending.entry(room.clone()).or_default().push(Pending {
            payload: payload.clone(),
            reply,
            images,
            error: None,
        });
        self.scroll.remove(&room);
        self.scroll_anchors.remove(&room);
        self.scroll_epoch += 1;
        let scroll = self.restore_scroll();
        Task::batch([scroll, self.send(room, payload)])
    }

    fn send(&mut self, room: RoomId, payload: Post) -> Task<Message> {
        let stamp = self.timeline.request_stamp();
        let api = ChatApi(self.api.clone());
        self.work(async move {
            let result = api.post(&room, &payload).await;
            Work::Post(room, stamp, payload.request_key, result)
        })
    }

    fn retry_post(&mut self, room: RoomId, key: RequestKey) -> Task<Message> {
        let post = self.pending.get_mut(&room).and_then(|pending| {
            pending
                .iter_mut()
                .find(|p| p.payload.request_key == key && p.error.is_some())
        });
        if let Some(post) = post {
            post.error = None;
            let payload = post.payload.clone();
            return self.send(room, payload);
        }
        Task::none()
    }

    fn discard_post(&mut self, room: &RoomId, key: &RequestKey) -> Task<Message> {
        let post = self.pending.get_mut(room).and_then(|pending| {
            pending
                .iter()
                .position(|p| &p.payload.request_key == key && p.error.is_some())
                .map(|index| pending.remove(index))
        });
        post.map_or_else(Task::none, |post| {
            Task::batch(
                post.payload
                    .attachment_ids
                    .into_iter()
                    .map(|id| self.cancel_draft(id)),
            )
        })
    }

    fn change(&mut self, room: RoomId, id: MessageId, change: Change) -> Task<Message> {
        let message = self.timeline.room(&room).and_then(|r| r.get(&id));
        let allowed = message.is_some_and(|message| {
            !message.deleted
                && (matches!(change, Change::Reaction(..)) || message.author_id == self.identity.id)
        });
        if !allowed || !self.changing.insert((room.clone(), id.clone())) {
            return Task::none();
        }
        let stamp = self.timeline.request_stamp();
        let api = ChatApi(self.api.clone());
        self.work(async move {
            let result = api.change(&room, &id, &change).await;
            Work::Change(room, stamp, id, change, result)
        })
    }

    fn pick(&mut self, room: RoomId) -> Task<Message> {
        self.work(async move {
            let files = rfd::AsyncFileDialog::new()
                .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif"])
                .pick_files()
                .await
                .map(|files| {
                    files
                        .into_iter()
                        .map(|file| file.path().to_path_buf())
                        .collect()
                });
            Work::Picked(room, files)
        })
    }

    fn import(&mut self, room: RoomId, paths: Vec<PathBuf>) -> Task<Message> {
        if paths.is_empty() {
            return Task::none();
        }
        let composer = self.composers.entry(room.clone()).or_default();
        let count = self
            .limits
            .count
            .saturating_sub(composer.drafts.len() + composer.queued_files.len());
        if count == 0 {
            composer.notice = Some(Notice::TooMany);
            return Task::none();
        }
        if paths.len() > count {
            composer.notice = Some(Notice::TooMany);
        }
        if composer.importing {
            // Winit emits one event per file and preserves their input order.
            composer.queued_files.extend(paths.into_iter().take(count));
            return Task::none();
        }
        composer.importing = true;
        let limits = self.limits;
        self.work(async move {
            let inputs = images::load_files(paths, count, limits).await;
            Work::Input(room, inputs)
        })
    }

    fn add_inputs(
        &mut self,
        room: RoomId,
        inputs: Vec<Result<Input, InputError>>,
    ) -> Task<Message> {
        let mut jobs = Vec::new();
        for input in inputs {
            let id = self.next_id();
            let composer = self.composers.entry(room.clone()).or_default();
            match input {
                Err(error) => composer.notice = Some(Notice::Input(error)),
                Ok(_) if composer.drafts.len() >= self.limits.count => {
                    composer.notice = Some(Notice::TooMany);
                }
                Ok(input) => {
                    composer.drafts.push(Draft {
                        id,
                        name: input.name.clone(),
                        preview: input.preview.clone(),
                        state: DraftState::Uploading(input.clone()),
                    });
                    jobs.push(self.upload(room.clone(), id, input));
                }
            }
        }
        Task::batch(jobs)
    }

    fn upload(&mut self, room: RoomId, id: u64, input: Input) -> Task<Message> {
        let api = AttachmentsApi(self.api.clone());
        self.work(async move {
            let result = api.upload(&room, input.name, input.bytes).await;
            Work::Uploaded(room, id, result)
        })
    }

    fn finish_upload(
        &mut self,
        room: RoomId,
        id: u64,
        result: Result<Attachment, ApiError>,
    ) -> Task<Message> {
        let draft = self
            .composers
            .get_mut(&room)
            .and_then(|c| c.drafts.iter_mut().find(|d| d.id == id));
        let Some(draft) = draft else {
            return result.map_or_else(|_| Task::none(), |a| self.cancel_draft(a.id));
        };
        if let DraftState::Uploading(input) = &draft.state {
            draft.state = match result {
                Ok(attachment) => DraftState::Ready(attachment),
                Err(error) => DraftState::Failed(input.clone(), error),
            };
        }
        Task::none()
    }

    fn remove_draft(&mut self, room: &RoomId, id: u64) -> Task<Message> {
        let draft = self.composers.get_mut(room).and_then(|c| {
            c.drafts
                .iter()
                .position(|draft| draft.id == id)
                .map(|index| c.drafts.remove(index))
        });
        if let Some(Draft {
            state: DraftState::Ready(attachment),
            ..
        }) = draft
        {
            return self.cancel_draft(attachment.id);
        }
        Task::none()
    }

    fn retry_draft(&mut self, room: RoomId, id: u64) -> Task<Message> {
        let draft = self
            .composers
            .get_mut(&room)
            .and_then(|c| c.drafts.iter_mut().find(|d| d.id == id));
        if let Some(draft) = draft
            && let DraftState::Failed(input, _) = &draft.state
        {
            let input = input.clone();
            draft.state = DraftState::Uploading(input.clone());
            return self.upload(room, id, input);
        }
        Task::none()
    }

    fn cancel_draft(&mut self, id: AttachmentId) -> Task<Message> {
        let api = AttachmentsApi(self.api.clone());
        self.work(async move { Work::Cancelled(api.cancel(&id).await) })
    }

    fn attachment(&self, room: &RoomId, id: &AttachmentId) -> Option<&Attachment> {
        self.timeline
            .room(room)?
            .messages()
            .flat_map(|message| &message.attachments)
            .find(|attachment| &attachment.id == id)
    }

    fn open_image(&mut self, room: &RoomId, id: AttachmentId) -> Task<Message> {
        if self.attachment(room, &id).is_some_and(is_available) {
            self.modal = Some(Modal::Image(id.clone()));
            let key = Key(id, Size::Viewer);
            self.visible.insert(key.clone());
            self.invalidate_image(&key);
            return self.fetch_visible();
        }
        Task::none()
    }

    fn close_modal(&mut self) -> Task<Message> {
        if let Some(Modal::Image(id)) = self.modal.take() {
            let key = Key(id, Size::Viewer);
            self.visible.remove(&key);
            self.invalidate_image(&key);
        }
        Task::none()
    }

    fn measured(&mut self, room: &RoomId, measured: view::Measured) -> Task<Message> {
        if !self.open || self.view_room.as_ref() != Some(room) {
            return Task::none();
        }
        if let Some(offset) = measured.corrected_offset {
            self.scroll.insert(room.clone(), offset);
            self.scroll_epoch += 1;
            return self.restore_scroll().chain(self.measure());
        }
        if self.scroll.get(room).copied().unwrap_or_default() > 48.0
            && let Some(first) = measured.first
        {
            self.scroll_anchors.insert(room.clone(), first);
        }
        let mut visible = measured
            .images
            .into_iter()
            .filter(|id| self.attachment(room, id).is_some_and(is_available))
            .map(|id| Key(id, Size::Thumbnail))
            .collect::<HashSet<_>>();
        if let Some(Modal::Image(id)) = &self.modal {
            visible.insert(Key(id.clone(), Size::Viewer));
        }
        self.visible = visible;
        self.validated.retain(|key| self.visible.contains(key));
        self.image_errors.retain(|key| self.visible.contains(key));
        for (key, generation) in &mut self.fetching {
            if !self.visible.contains(key) {
                *generation = None;
            }
        }
        self.fetch_visible()
    }

    fn fetch_visible(&mut self) -> Task<Message> {
        let room = self.view_room.as_ref();
        let mut wanted = self
            .visible
            .iter()
            .filter(|key| {
                !self.fetching.contains_key(*key)
                    && !self.image_errors.contains(*key)
                    && (!self.validated.contains(*key) || self.cache.peek(key).is_none())
                    && room
                        .and_then(|room| self.attachment(room, &key.0))
                        .is_some_and(is_available)
            })
            .cloned()
            .collect::<Vec<_>>();
        wanted.sort_by_key(|key| key.1 != Size::Viewer);
        wanted.truncate(MAX_FETCHES.saturating_sub(self.fetching.len()));
        Task::batch(wanted.into_iter().map(|key| {
            let etag = self.cache.etag(&key);
            let api = AttachmentsApi(self.api.clone());
            let limit = self.limits.output_bytes;
            let generation = self.next_id();
            self.fetching.insert(key.clone(), Some(generation));
            self.work(async move {
                let result = images::fetch(api, key.clone(), etag, limit).await;
                Work::Image(generation, key, result)
            })
        }))
    }

    fn finish_image(
        &mut self,
        generation: u64,
        key: Key,
        result: Result<Fetched, ApiError>,
    ) -> Task<Message> {
        if self
            .fetching
            .get(&key)
            .is_some_and(|current| current.is_some_and(|current| current != generation))
        {
            return Task::none();
        }
        if self.fetching.remove(&key) == Some(Some(generation)) && !self.timeline.is_expired(&key.0)
        {
            match result {
                Ok(Fetched::Expired) => self.expire(vec![key.0]),
                Ok(Fetched::Unchanged) => {
                    if self.visible.contains(&key) && self.cache.peek(&key).is_some() {
                        self.validated.insert(key);
                    }
                }
                Ok(Fetched::Image(image)) => {
                    self.cache.insert(key.clone(), image);
                    if self.visible.contains(&key) {
                        self.validated.insert(key);
                    }
                }
                Err(_) => {
                    self.cache.remove(&key);
                    if self.visible.contains(&key) {
                        self.image_errors.insert(key);
                    }
                }
            }
        }
        self.fetch_visible()
    }

    fn expire(&mut self, ids: Vec<AttachmentId>) {
        for id in &ids {
            for size in [Size::Thumbnail, Size::Viewer] {
                let key = Key(id.clone(), size);
                self.cache.remove(&key);
                self.invalidate_image(&key);
            }
        }
        self.timeline.expire(ids);
    }

    fn invalidate_image(&mut self, key: &Key) {
        self.validated.remove(key);
        self.image_errors.remove(key);
        if let Some(generation) = self.fetching.get_mut(key) {
            *generation = None;
        }
    }

    fn invalidate_image_revalidation(&mut self) {
        self.validated.clear();
        self.image_errors.clear();
        // Invalidated downloads still occupy a slot until the response finishes.
        self.fetching
            .values_mut()
            .for_each(|generation| *generation = None);
    }

    fn measure(&self) -> Task<Message> {
        let Some(room) = self.view_room.as_ref().filter(|_| self.open) else {
            return Task::none();
        };
        let ids = self
            .timeline
            .room(room)
            .into_iter()
            .flat_map(|timeline| timeline.messages())
            .flat_map(|m| &m.attachments)
            .filter(|a| falky_core::attachments::is_image(&a.content_type))
            .map(|a| (view::image_widget_id(&a.id), a.id.clone()))
            .collect();
        let rows = self
            .timeline
            .room(room)
            .into_iter()
            .flat_map(|timeline| timeline.messages())
            .map(|message| view::message_widget_id(&message.id))
            .collect();
        let anchor = self.scroll_anchors.get(room).cloned();
        let epoch = self.scroll_epoch;
        let room = room.clone();
        iced::advanced::widget::operate(view::Measure::new(ids, rows, anchor))
            .map(move |measured| Message::Measured(room.clone(), epoch, measured))
    }
}
