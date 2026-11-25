use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_hdr_async, tungstenite::handshake::server};

#[test]
fn canonical_origin_restricts_plaintext_and_paths() {
    assert_eq!(
        Origin::parse(" HTTPS://ExAmPle.org:443/ ")
            .unwrap()
            .as_str(),
        "https://example.org"
    );
    assert_eq!(
        Origin::parse("http://LOCALHOST:7080").unwrap().as_str(),
        "http://localhost:7080"
    );
    assert_eq!(
        Origin::parse("http://127.0.0.1:7080/").unwrap().as_str(),
        "http://127.0.0.1:7080"
    );
    for input in [
        "http://localhost.example",
        "http://localhost.",
        "http://127.1",
        "http://2130706433",
        "http://127.0.0.2",
        "http://%6cocalhost",
        "http://[::1]",
        "https://example.org/a/..",
        "https://example.org/?",
        "https://example.org/#",
        "https://@example.org",
        "https://user:pass@example.org",
        "https://example.org\\@outside.example",
        "https:///example.org",
    ] {
        assert!(Origin::parse(input).is_err(), "{input}");
    }
    let origin = Origin::parse("https://example.org").unwrap();
    assert_eq!(
        origin
            .endpoint(&["api", "id/with?delimiter#"])
            .unwrap()
            .path(),
        "/api/id%2Fwith%3Fdelimiter%23",
    );
    assert!(origin.endpoint(&["api", ".."]).is_none());
    assert!(serde_json::from_str::<Origin>(r#""http://127.1""#).is_err());
}

#[tokio::test]
async fn loopback_http_and_websocket_share_secure_path_scoped_cookies() {
    for host in ["localhost", "127.0.0.1"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Origin::parse(&format!(
            "http://{host}:{}",
            listener.local_addr().unwrap().port()
        ))
        .unwrap();
        let expected_origin = origin.clone();
        let fixture = tokio::spawn(async move {
            let (mut begin, _) = listener.accept().await.unwrap();
            let request = read_request(&mut begin).await;
            assert!(request.starts_with("POST /api/accounts/qr-signins HTTP/1.1"));
            assert!(request.contains(&format!("origin: {expected_origin}\r\n")));
            assert!(request.contains("content-type: application/json\r\n"));
            assert!(request.contains(&format!("user-agent: {}\r\n", user_agent())));
            assert!(request.ends_with(r#"{"replace":false}"#));
            reply(&mut begin, "201 Created", &[
                ("Set-Cookie", "__Host-falky-signin=fixture_binding; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Strict"),
            ], "{}").await;

            let (mut finish, _) = listener.accept().await.unwrap();
            let request = read_request(&mut finish).await;
            assert!(request.starts_with("POST /api/accounts/signin-requests/test/finish HTTP/1.1"));
            assert!(request.contains("cookie: __Host-falky-signin=fixture_binding\r\n"));
            assert!(request.ends_with("{}"));
            reply(&mut finish, "200 OK", &[
                ("Set-Cookie", "falky_visitor=fixture_session; Path=/api; Max-Age=3600; HttpOnly; Secure; SameSite=Strict"),
                ("Authorization", "fixture_private_header"),
                ("ETag", "fixture_tag"),
            ], "{}").await;

            let (mut public, _) = listener.accept().await.unwrap();
            let request = read_request(&mut public).await;
            assert!(request.starts_with("GET /outside HTTP/1.1"));
            assert!(!request.contains("falky_visitor"));
            reply(&mut public, "200 OK", &[], "{}").await;

            let (socket, _) = listener.accept().await.unwrap();
            #[allow(clippy::result_large_err)]
            let _socket = accept_hdr_async(
                socket,
                |request: &server::Request, response: server::Response| {
                    assert_eq!(request.uri().path(), "/api/live");
                    assert_eq!(request.headers()[ORIGIN], expected_origin.as_str());
                    let cookie = request.headers()[COOKIE].to_str().unwrap();
                    assert!(cookie.contains("falky_visitor=fixture_session"));
                    assert!(cookie.contains("__Host-falky-signin=fixture_binding"));
                    Ok(response)
                },
            )
            .await
            .unwrap();
        });

        let client = ApiClient::new(origin).unwrap();
        client
            .send(
                client
                    .request(Method::POST, &["api", "accounts", "qr-signins"])
                    .json(&serde_json::json!({ "replace": false })),
            )
            .await
            .unwrap();
        let response = client
            .send(
                client
                    .request(
                        Method::POST,
                        &["api", "accounts", "signin-requests", "test", "finish"],
                    )
                    .empty_json(),
            )
            .await
            .unwrap();
        assert!(!response.headers().contains_key(SET_COOKIE));
        assert!(!response.headers().contains_key(AUTHORIZATION));
        assert_eq!(response.headers()[reqwest::header::ETAG], "fixture_tag");
        let cookie = client.session_cookie().unwrap();
        assert_eq!(cookie.secret.expose_secret(), "fixture_session");
        assert!(!format!("{cookie:?}").contains("fixture_session"));
        client
            .send(client.request(Method::GET, &["outside"]))
            .await
            .unwrap();
        let _socket = client.websocket(&["api", "live"]).await.unwrap();
        client.clear_session_cookie();
        client.clear_signin_cookie();
        assert!(client.session_cookie().is_none());
        let expiry = Utc::now() + chrono::Duration::minutes(1);
        let other = ApiClient::new(Origin::parse("https://elsewhere.example").unwrap()).unwrap();
        assert!(!other.restore_session_cookie(&cookie, expiry));
        assert!(other.session_cookie().is_none());
        assert!(client.restore_session_cookie(&cookie, expiry));
        assert_eq!(client.session_cookie(), Some(cookie));
        fixture.await.unwrap();
    }
}

#[tokio::test]
async fn refuses_foreign_requests_and_redirects_and_preserves_safe_error_data() {
    let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let other_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_origin = Origin::parse(&format!("http://{}", server.local_addr().unwrap())).unwrap();
    let other_origin =
        Origin::parse(&format!("http://{}", other_server.local_addr().unwrap())).unwrap();
    let redirect = format!("{other_origin}/capture");
    let fixture = tokio::spawn(async move {
        let (mut stream, _) = server.accept().await.unwrap();
        assert!(
            read_request(&mut stream)
                .await
                .starts_with("GET /api/redirect HTTP/1.1")
        );
        reply(&mut stream, "302 Found", &[("Location", &redirect)], "{}").await;
        let (mut stream, _) = server.accept().await.unwrap();
        let _ = read_request(&mut stream).await;
        reply(
            &mut stream,
            "429 Too Many Requests",
            &[("Retry-After", "13")],
            r#"{"code":"rate_limited","message":"private-content"}"#,
        )
        .await;
    });
    let client = ApiClient::new(first_origin).unwrap();
    let other_client = ApiClient::new(other_origin).unwrap();
    assert_eq!(
        client
            .send(other_client.request(Method::GET, &["api", "capture"]))
            .await
            .unwrap_err(),
        ApiError::InvalidRequest,
    );
    let error = client
        .send(client.request(Method::GET, &["api", "redirect"]))
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(StatusCode::FOUND));
    let error = client
        .send(client.request(Method::GET, &["api", "limit"]))
        .await
        .unwrap_err();
    assert_eq!(error.status(), Some(StatusCode::TOO_MANY_REQUESTS));
    assert_eq!(error.code(), Some("rate_limited"));
    assert_eq!(error.retry_after(), Some(Duration::from_secs(13)));
    assert!(!format!("{error:?}").contains("private-content"));
    fixture.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(60), other_server.accept())
            .await
            .is_err()
    );
}

async fn read_request(stream: &mut TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let received = stream.read(&mut buffer).await.unwrap();
        assert_ne!(received, 0);
        request.extend_from_slice(&buffer[..received]);
        let text = std::str::from_utf8(&request).unwrap();
        if let Some((headers, body)) = text.split_once("\r\n\r\n") {
            let length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length: "))
                .map_or(0, |value| value.parse::<usize>().unwrap());
            if body.len() >= length {
                return text.to_owned();
            }
        }
    }
}

async fn reply(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)], body: &str) {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        body.len(),
    );
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(body);
    stream.write_all(response.as_bytes()).await.unwrap();
}
