use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const SESSION: &str = r#"{"kind":"account","expiresAt":"2099-06-01T00:00:00Z","visitor":{"id":"account","name":"Falky","nameTaken":false,"colour":{"visitorId":"account","palette":"sky","revision":0}}}"#;
const BINDING: &str = "Set-Cookie: __Host-falky-signin=fixture; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict\r\n";
const COOKIE: &str = "Set-Cookie: falky_visitor=fixture; Path=/api; Max-Age=600; Secure; HttpOnly; SameSite=Strict\r\n";

async fn request(
    listener: &TcpListener,
    path: &str,
    body: &str,
    status: &str,
    headers: &str,
    response: &str,
) -> String {
    let (mut stream, received) = read_request(listener, path, body).await;
    send_response(&mut stream, status, headers, response).await;
    received
}

async fn read_request(
    listener: &TcpListener,
    path: &str,
    body: &str,
) -> (tokio::net::TcpStream, String) {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).await.unwrap();
        assert_ne!(n, 0);
        bytes.extend_from_slice(&buffer[..n]);
        let current = std::str::from_utf8(&bytes).unwrap();
        if let Some((_, received)) = current.split_once("\r\n\r\n")
            && received.len() >= body.len()
        {
            assert!(current.starts_with(path));
            assert_eq!(received, body);
            break;
        }
    }
    (stream, String::from_utf8(bytes).unwrap())
}

async fn send_response(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    headers: &str,
    response: &str,
) {
    stream.write_all(format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}\r\n{response}", response.len()).as_bytes()).await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires an isolated, unlocked Secret Service keyring"]
async fn verified_restore_keeps_concurrent_keyring_replacement_or_deletion() {
    assert!(std::env::var_os("FALKY_TEST_ISOLATED_KEYRING").is_some());
    for replacement in [Some("newer-session"), None, Some("original-session")] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let previous = SessionCredential {
            origin: origin.clone(),
            secret: Secret::new("original-session".into()),
        };
        let expiry = Utc::now() + chrono::Duration::hours(1);
        assert!(
            Keyring::save(SavedCredential {
                cookie: previous.clone(),
                expires_at: expiry
            })
            .await
        );
        let candidate = Candidate::new(origin.clone(), SessionGeneration(1)).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, headers) =
                read_request(&listener, "GET /api/accounts/session ", "").await;
            assert!(headers.contains("cookie: falky_visitor=original-session\r\n"));
            match replacement {
                Some("original-session") => {}
                Some(newer) => {
                    let cookie = SessionCredential {
                        origin: previous.origin,
                        secret: Secret::new(newer.into()),
                    };
                    assert!(
                        Keyring::save(SavedCredential {
                            cookie,
                            expires_at: expiry
                        })
                        .await
                    );
                }
                None => assert!(Keyring::forget(previous).await),
            }
            send_response(&mut stream, "200 OK", "", SESSION).await;
        });

        let Restore::Account(auth) = candidate.restore(SessionGeneration(2)).await.unwrap() else {
            panic!("expected authenticated restore")
        };
        assert_eq!(auth.scope.generation, SessionGeneration(2));
        assert_eq!(auth.account.visitor.id.as_str(), "account");
        assert_eq!(auth.remembered, replacement == Some("original-session"));
        assert_eq!(
            auth.client.session_cookie().unwrap().secret.expose_secret(),
            "original-session"
        );
        server.await.unwrap();

        let stored = Keyring::load(origin).await.unwrap();
        assert_eq!(
            stored
                .as_ref()
                .map(|record| record.cookie.secret.expose_secret()),
            replacement
        );
        if let Some(stored) = stored {
            assert_eq!(stored.expires_at, expiry);
            assert!(Keyring::forget(stored.cookie).await);
        }
    }
}

#[tokio::test]
async fn begin_recovers_binding_and_exposes_cooldown() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin.clone(), SessionGeneration(1)).unwrap();
    let expected = origin.clone();
    let server = tokio::spawn(async move {
        let first = request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "403 Forbidden",
            BINDING,
            r#"{"code":"invalid_proof"}"#,
        )
        .await;
        assert!(first.contains(&format!("origin: {expected}\r\n")));
        let second = request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":true}"#,
            "429 Too Many Requests",
            "Retry-After: 3\r\n",
            r#"{"code":"rate_limited"}"#,
        )
        .await;
        assert!(second.contains("cookie: __Host-falky-signin=fixture\r\n"));
    });
    let Err(Error::Api(error)) = candidate.begin(false).await else {
        panic!("expected cooldown")
    };
    assert_eq!(error.retry_after(), Some(Duration::from_secs(3)));
    server.await.unwrap();
}

#[tokio::test]
async fn uncertain_finish_checks_same_jar_before_replaying_and_cancel_reconciles_conflict() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin, SessionGeneration(3)).unwrap();
    let server = tokio::spawn(async move {
        request(
            &listener,
            "GET /api/accounts/session ",
            "",
            "401 Unauthorized",
            BINDING,
            "{}",
        )
        .await;
        let finish = request(
            &listener,
            "POST /api/accounts/signin-requests/qr/finish ",
            "{}",
            "500 Internal Server Error",
            COOKIE,
            "{}",
        )
        .await;
        assert!(finish.contains("content-type: application/json\r\n"));
        assert!(finish.contains("__Host-falky-signin=fixture"));
        let read = request(
            &listener,
            "GET /api/accounts/session ",
            "",
            "200 OK",
            "",
            SESSION,
        )
        .await;
        assert!(read.contains("falky_visitor=fixture"));
        request(
            &listener,
            "DELETE /api/accounts/qr-signins/qr ",
            "",
            "409 Conflict",
            "",
            r#"{"code":"signin_conflict"}"#,
        )
        .await;
        request(
            &listener,
            "GET /api/accounts/session ",
            "",
            "200 OK",
            "",
            SESSION,
        )
        .await;
    });
    let id = SignInRequestId::from("qr");
    let expires = Utc::now() + chrono::Duration::minutes(5);
    let session = candidate.finish(&id, expires).await.unwrap();
    assert_eq!(session.visitor.id.as_str(), "account");
    assert_eq!(candidate.cancel(Some(&id)).await.unwrap(), Some(session));
    server.await.unwrap();
}

#[test]
fn remembered_origin_uses_atomic_replacement_without_credentials() {
    let root = tempfile::tempdir().unwrap();
    let store = OriginStore::at(root.path().join("origin.json"));
    for origin in ["https://falky.example", "http://localhost:8082"] {
        let origin: Origin = origin.parse().unwrap();
        store.save(&origin).unwrap();
        assert_eq!(store.load().unwrap(), Some(origin.clone()));
        assert_eq!(
            std::fs::read_to_string(store.path.as_ref().unwrap()).unwrap(),
            format!("\"{origin}\"")
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[tokio::test]
async fn bound_cancel_recovers_an_unknown_request_without_unbound_allocation() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin, SessionGeneration(4)).unwrap();
    assert_eq!(candidate.cancel(None).await.unwrap(), None);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    let server = tokio::spawn(async move {
        request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "200 OK",
            BINDING,
            "{",
        )
        .await;
        let recovered = request(&listener, "POST /api/accounts/qr-signins ", r#"{"replace":false}"#, "200 OK", "", r#"{"request":{"id":"qr","type":"qr","state":"pending","version":1,"requesterUserAgent":"Linux","createdAt":"2099-06-01T00:00:00Z","expiresAt":"2099-06-01T00:05:00Z"}}"#).await;
        assert!(recovered.contains("__Host-falky-signin=fixture"));
        request(
            &listener,
            "DELETE /api/accounts/qr-signins/qr ",
            "",
            "200 OK",
            "",
            "{}",
        )
        .await;
    });
    assert!(matches!(
        candidate.begin(false).await,
        Err(Error::Api(ApiError::InvalidResponse))
    ));
    assert_eq!(candidate.cancel(None).await.unwrap(), None);
    server.await.unwrap();
}

#[tokio::test]
async fn cancel_reconciles_a_lost_replacement_before_using_the_old_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin.clone(), SessionGeneration(5)).unwrap();
    let server = tokio::spawn(async move {
        let old = format!(
            r#"{{"request":{},"url":"{origin}/#qr-signin=opaque"}}"#,
            qr_request("old", "pending")
        );
        request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "200 OK",
            BINDING,
            &old,
        )
        .await;
        request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":true}"#,
            "200 OK",
            BINDING,
            "{",
        )
        .await;
        let new = format!(r#"{{"request":{}}}"#, qr_request("new", "pending"));
        let lookup = request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "200 OK",
            BINDING,
            &new,
        )
        .await;
        assert!(lookup.contains("__Host-falky-signin=fixture"));
        request(
            &listener,
            "DELETE /api/accounts/qr-signins/new ",
            "",
            "200 OK",
            "",
            "{}",
        )
        .await;
    });
    let old = candidate.begin(false).await.unwrap().request.id;
    assert!(matches!(
        candidate.clone().begin(true).await,
        Err(Error::Api(ApiError::InvalidResponse))
    ));
    assert!(candidate.binding_uncertain());
    assert_eq!(candidate.cancel(Some(&old)).await.unwrap(), None);
    assert!(!candidate.binding_uncertain());
    server.await.unwrap();
}

#[tokio::test]
async fn uncertain_cancel_will_not_start_a_qr_after_the_known_lookup_window() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin, SessionGeneration(6)).unwrap();
    let server = tokio::spawn(async move {
        request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "200 OK",
            BINDING,
            "{",
        )
        .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    });
    assert!(candidate.begin(false).await.is_err());
    assert!(candidate.client.has_signin_cookie());
    candidate
        .binding
        .lock()
        .unwrap()
        .uncertain
        .as_mut()
        .unwrap()
        .lookup_before = Some(Utc::now());
    assert_eq!(
        candidate.cancel(Some(&"old".into())).await,
        Err(Error::OutcomeUnknown)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancel_conflict_replays_consumed_delivery_with_the_same_proof() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let candidate = Candidate::new(origin.clone(), SessionGeneration(7)).unwrap();
    let server = tokio::spawn(async move {
        let begun = format!(
            r#"{{"request":{},"url":"{origin}/#qr-signin=opaque"}}"#,
            qr_request("qr", "pending")
        );
        request(
            &listener,
            "POST /api/accounts/qr-signins ",
            r#"{"replace":false}"#,
            "200 OK",
            BINDING,
            &begun,
        )
        .await;
        request(
            &listener,
            "DELETE /api/accounts/qr-signins/qr ",
            "",
            "409 Conflict",
            "",
            r#"{"code":"signin_conflict"}"#,
        )
        .await;
        request(
            &listener,
            "GET /api/accounts/session ",
            "",
            "401 Unauthorized",
            "",
            "{}",
        )
        .await;
        request(
            &listener,
            "GET /api/accounts/signin-requests/qr ",
            "",
            "200 OK",
            "",
            &qr_request("qr", "consumed"),
        )
        .await;
        let replay = request(
            &listener,
            "POST /api/accounts/signin-requests/qr/finish ",
            "{}",
            "200 OK",
            COOKIE,
            SESSION,
        )
        .await;
        assert!(replay.contains("__Host-falky-signin=fixture"));
        assert!(!replay.contains("falky_visitor="));
        let authorized = request(
            &listener,
            "GET /api/accounts/session ",
            "",
            "200 OK",
            "",
            SESSION,
        )
        .await;
        assert!(authorized.contains("falky_visitor=fixture"));
    });
    let id = candidate.begin(false).await.unwrap().request.id;
    let account = candidate.cancel(Some(&id)).await.unwrap().unwrap();
    assert_eq!(account.visitor.id.as_str(), "account");
    server.await.unwrap();
}

fn qr_request(id: &str, state: &str) -> String {
    format!(
        r#"{{"id":"{id}","type":"qr","state":"{state}","version":1,"requesterUserAgent":"Linux","createdAt":"2099-06-01T00:00:00Z","expiresAt":"2099-06-01T00:05:00Z"}}"#
    )
}

#[tokio::test]
async fn live_flushes_pong_during_snapshot_and_retries_transient_close_codes() {
    use crate::{
        live::{self, Notice},
        model::{LivePayload, ReconnectGeneration, VisitorId},
    };
    use futures_util::{SinkExt, StreamExt};
    use tokio::sync::{mpsc, watch};
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::{
            Message,
            handshake::server,
            protocol::{CloseFrame, frame::coding::CloseCode},
        },
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin: Origin = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let credential = SessionCredential {
        origin: origin.clone(),
        secret: Secret::new("fixture".into()),
    };
    let account: AccountSession = serde_json::from_str(SESSION).unwrap();
    let client = ApiClient::new(origin.clone()).unwrap();
    assert!(client.restore_session_cookie(&credential, account.expires_at.unwrap()));
    let auth = Authenticated {
        scope: SessionScope {
            origin,
            generation: SessionGeneration(5),
        },
        client,
        account,
        remembered: false,
        credential,
    };

    let (advance, mut after_updates) = mpsc::channel(1);
    let server = tokio::spawn(async move {
        for close in [4000, 1001, 4001] {
            let (tcp, _) = listener.accept().await.unwrap();
            #[allow(clippy::result_large_err)]
            let mut ws = accept_hdr_async(tcp, |req: &server::Request, resp: server::Response| {
                assert_eq!(req.uri().path(), "/api/live");
                assert_eq!(req.headers()["cookie"], "falky_visitor=fixture");
                assert!(
                    req.headers()["origin"]
                        .to_str()
                        .unwrap()
                        .starts_with("http://127.0.0.1:")
                );
                Ok(resp)
            })
            .await
            .unwrap();
            ws.send(Message::Text(r#"{"v":1,"type":"room.changed","eventId":"id","timestamp":"2099-01-01T00:00:00Z","payload":{"id":"r","name":"Live name"}}"#.into())).await.unwrap();
            ws.send(Message::Ping(b"slow snapshot".as_slice().into()))
                .await
                .unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), ws.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                Message::Pong(b"slow snapshot".as_slice().into())
            );

            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buf = [0; 4096];
                let size = stream.read(&mut buf).await.unwrap();
                let headers = std::str::from_utf8(&buf[..size]).unwrap();
                assert!(headers.contains("cookie: falky_visitor=fixture\r\n"));
                let body = if headers.starts_with("GET /api/accounts/session ") {
                    SESSION
                } else {
                    assert!(headers.starts_with("GET /api/rooms "));
                    r#"{"rooms":[{"id":"r","name":"Snapshot name","occupancy":[{"connectionId":"c","visitorId":"occupant","name":"Occupant"}]}]}"#
                };
                stream.write_all(format!("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }

            request(
                &listener,
                "POST /api/visitor-colours ",
                r#"{"visitorIds":["account","author","occupant"]}"#,
                "200 OK",
                "",
                r#"{"colours":[{"visitorId":"author","palette":"plum","revision":14}]}"#,
            )
            .await;
            after_updates.recv().await.unwrap();
            ws.send(Message::Close(Some(CloseFrame {
                code: CloseCode::from(close),
                reason: "".into(),
            })))
            .await
            .unwrap();
        }
    });

    let (_ids_tx, ids) = watch::channel(vec![VisitorId::from("author"), VisitorId::from("author")]);
    let (tx, mut rx) = mpsc::channel(1);
    let scope = auth.scope.clone();
    let live = tokio::spawn(live::run(auth, ids, tx));
    for i in 1..=3 {
        let recv = async |rx: &mut mpsc::Receiver<Notice>| {
            tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap()
        };
        let Notice::Connected(connected) = recv(&mut rx).await else {
            panic!("expected a new generation")
        };
        assert_eq!(connected.session, scope);
        assert_eq!(connected.generation, ReconnectGeneration(i));
        let Notice::Snapshot(snapshot) = recv(&mut rx).await else {
            panic!("expected a snapshot before buffered events")
        };
        assert_eq!(snapshot.scope, connected);
        assert_eq!(snapshot.rooms[0].name, "Snapshot name");
        assert_eq!(snapshot.colours[0].revision, 14);
        let Notice::Update(update) = recv(&mut rx).await else {
            panic!("expected a typed event")
        };
        assert_eq!(update.scope, connected);
        assert!(
            matches!(update.event.payload, LivePayload::RoomChanged(room) if room.name == "Live name")
        );
        advance.send(()).await.unwrap();
        match recv(&mut rx).await {
            Notice::Reconnecting(received) if i < 3 => assert_eq!(received, scope),
            Notice::Revoked(received) if i == 3 => assert_eq!(received, scope),
            notice => panic!("unexpected close observation {notice:?}"),
        }
    }
    live.await.unwrap();
    server.await.unwrap();
    assert!(rx.recv().await.is_none());
}
