use std::{
    collections::{BTreeSet, VecDeque},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::time;
use tokio_tungstenite::tungstenite::Message;

use crate::{
    model::{
        LiveEvent, LivePayload, LiveScope, LiveUpdate, ReconnectGeneration, ReconnectSnapshot,
        Room, SessionScope, VisitorColour, VisitorId,
    },
    session::{Authenticated, account_session},
    transport::{ApiClient, ApiError, Method, WebSocket},
};

const LIVE: &[&str] = &["api", "live"];
const MAX_PENDING: usize = 128;
const BACKOFF_MIN_MS: u64 = 500;
const BACKOFF_MAX_MS: u64 = 10_000;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(35);

#[derive(Clone, Debug)]
pub enum Notice {
    Connected(LiveScope),
    Snapshot(ReconnectSnapshot),
    Update(LiveUpdate),
    Reconnecting(SessionScope),
    Revoked(SessionScope),
}

enum Disconnected {
    Retry,
    Revoked,
    Stopped,
}

/// A session-scoped live stream. Drop the receiver or the running future to
/// stop it. First/reconnect snapshots are preceded by `Connected` and followed
/// by the frames received while fetching the snapshot. Consumers capture any
/// pre-connect chat cursors when they receive `Connected`.
pub async fn run(
    auth: Authenticated,
    relevant: watch::Receiver<Vec<VisitorId>>,
    out: mpsc::Sender<Notice>,
) {
    let expiry = auth
        .account
        .expires_at
        .and_then(|expiry| (expiry - chrono::Utc::now()).to_std().ok())
        .unwrap_or_default();
    tokio::select! {
        () = run_socket(&auth, relevant, &out) => {},
        () = time::sleep(expiry) => {
            let _ = out.send(Notice::Revoked(auth.scope)).await;
        }
    }
}

async fn run_socket(
    auth: &Authenticated,
    relevant: watch::Receiver<Vec<VisitorId>>,
    out: &mpsc::Sender<Notice>,
) {
    let mut generation = 0;
    let mut attempts = 0_u32;
    loop {
        let opened = tokio::select! {
            () = out.closed() => return,
            opened = auth.client.websocket(LIVE) => opened,
        };
        let (end, caught_up, retry_after) = match opened {
            Ok(mut socket) => {
                generation += 1;
                let scope = LiveScope {
                    session: auth.scope.clone(),
                    generation: ReconnectGeneration(generation),
                };
                let mut caught_up = false;
                let end = connected(
                    &auth.client,
                    &mut socket,
                    scope,
                    &relevant,
                    out,
                    &mut caught_up,
                )
                .await;
                (end, caught_up, None)
            }
            Err(error) if error.is_unauthorized() => (Disconnected::Revoked, false, None),
            Err(error) => (Disconnected::Retry, false, error.retry_after()),
        };
        match end {
            Disconnected::Stopped => return,
            Disconnected::Revoked => {
                let _ = out.send(Notice::Revoked(auth.scope.clone())).await;
                return;
            }
            Disconnected::Retry => {}
        }
        if out
            .send(Notice::Reconnecting(auth.scope.clone()))
            .await
            .is_err()
        {
            return;
        }
        if caught_up {
            attempts = 0;
        }
        let delay = backoff(attempts).max(retry_after.unwrap_or_default());
        attempts = attempts.saturating_add(1);
        tokio::select! {
            () = out.closed() => return,
            () = time::sleep(delay) => {}
        }
    }
}

async fn connected(
    client: &ApiClient,
    socket: &mut WebSocket,
    scope: LiveScope,
    relevant: &watch::Receiver<Vec<VisitorId>>,
    out: &mpsc::Sender<Notice>,
    caught_up: &mut bool,
) -> Disconnected {
    let reconcile = time::timeout(SNAPSHOT_TIMEOUT, snapshot(client, scope.clone(), relevant));
    tokio::pin!(reconcile);
    let idle = time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle);
    let mut pending = VecDeque::from([Notice::Connected(scope.clone())]);
    let mut before_snapshot = VecDeque::new();
    loop {
        tokio::select! {
            () = out.closed() => return Disconnected::Stopped,
            () = &mut idle => return Disconnected::Retry,
            result = &mut reconcile, if !*caught_up => match result {
                Ok(Ok(snapshot)) => {
                    pending.push_back(Notice::Snapshot(snapshot));
                    pending.append(&mut before_snapshot);
                    *caught_up = true;
                }
                Ok(Err(error)) if error.is_unauthorized() => return Disconnected::Revoked,
                _ => return Disconnected::Retry,
            },
            permit = out.reserve(), if !pending.is_empty() => match permit {
                Ok(permit) => permit.send(pending.pop_front().expect("there is a queued notice")),
                Err(_) => return Disconnected::Stopped,
            },
            frame = socket.next() => {
                idle.as_mut().reset(time::Instant::now() + IDLE_TIMEOUT);
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(event) = serde_json::from_str::<LiveEvent>(&text) else { continue };
                        match event.payload {
                            LivePayload::Unknown | LivePayload::SignInStateChanged(_) => continue,
                            LivePayload::AccessRevoked(_) => return Disconnected::Revoked,
                            _ => {}
                        }
                        if pending.len() + before_snapshot.len() >= MAX_PENDING {
                            return Disconnected::Retry;
                        }
                        let notice = Notice::Update(LiveUpdate { scope: scope.clone(), event });
                        if *caught_up {
                            pending.push_back(notice);
                        } else {
                            before_snapshot.push_back(notice);
                        }
                    }
                    Some(Ok(Message::Ping(_))) => {
                        // Tungstenite queued the matching Pong on read. Flush it
                        // even while room/session/colour requests are pending.
                        if !matches!(time::timeout(WRITE_TIMEOUT, socket.flush()).await, Ok(Ok(()))) {
                            return Disconnected::Retry;
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let _ = time::timeout(WRITE_TIMEOUT, socket.flush()).await;
                        return if frame.is_some_and(|frame| u16::from(frame.code) == 4001) {
                            Disconnected::Revoked
                        } else {
                            Disconnected::Retry
                        };
                    }
                    None | Some(Err(_)) => return Disconnected::Retry,
                    _ => {}
                }
            }
        }
    }
}

async fn snapshot(
    client: &ApiClient,
    scope: LiveScope,
    relevant: &watch::Receiver<Vec<VisitorId>>,
) -> Result<ReconnectSnapshot, ApiError> {
    #[derive(Deserialize)]
    struct RoomList {
        rooms: Vec<Room>,
    }
    let (session, RoomList { rooms }) = tokio::try_join!(
        account_session(client),
        client.json(client.request(Method::GET, &["api", "rooms"])),
    )?;
    let mut ids = relevant.borrow().clone();
    ids.push(session.visitor.id.clone());
    ids.extend(rooms.iter().flat_map(|room| {
        room.occupancy
            .iter()
            .map(|participant| participant.visitor_id.clone())
    }));
    let colours = colours(client, ids).await?;
    Ok(ReconnectSnapshot {
        scope,
        session,
        rooms,
        colours,
    })
}

/// Requests only explicit visitor IDs. The app may use this after a snapshot
/// when chat catch-up, live occupancy, or the voice roster reveals new IDs.
pub async fn colours(
    client: &ApiClient,
    ids: impl IntoIterator<Item = VisitorId>,
) -> Result<Vec<VisitorColour>, ApiError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Lookup<'a> {
        visitor_ids: &'a [VisitorId],
    }

    #[derive(Deserialize)]
    struct List {
        colours: Vec<VisitorColour>,
    }

    let ids: Vec<_> = ids
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut assignments = Vec::new();
    for batch in ids.chunks(100) {
        let list: List = client
            .json(
                client
                    .request(Method::POST, &["api", "visitor-colours"])
                    .json(&Lookup { visitor_ids: batch }),
            )
            .await?;
        assignments.extend(list.colours);
    }
    Ok(assignments)
}

fn backoff(attempts: u32) -> Duration {
    let ms = (BACKOFF_MIN_MS << attempts.min(5)).min(BACKOFF_MAX_MS);
    let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * ms / (255 * 5);
    Duration::from_millis((ms + jitter).min(BACKOFF_MAX_MS))
}
