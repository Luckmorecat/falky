use super::*;
use crate::transport::Origin;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[test]
fn trims_and_validates_names_in_unicode_scalars() {
    assert_eq!(
        VisitorName::parse(" \tЛеся\u{a0}").unwrap().as_str(),
        "Леся"
    );
    assert!(VisitorName::parse(&"🙂".repeat(32)).is_ok());
    for invalid in [" \t", "a\nb", "a\u{202e}b", "a\u{061c}b", &"🙂".repeat(33)] {
        assert_eq!(VisitorName::parse(invalid), Err(InvalidVisitorName));
    }
}

#[tokio::test]
async fn profile_wire_contract_keeps_scope_and_authoritative_revisions() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let client = ApiClient::new(Origin::parse(&origin).unwrap()).unwrap();
    let server = tokio::spawn(async move {
        let fixture = [
            (
                "PATCH /api/me HTTP/1.1",
                json!({"name":"Леся"}),
                "200 OK",
                json!({"id":"own","name":"Леся","nameTaken":false,"colour":{"visitorId":"own","palette":"sky","revision":3}}),
            ),
            (
                "PUT /api/me/colour HTTP/1.1",
                json!({"palette":"ocean"}),
                "200 OK",
                json!({"visitorId":"own","palette":"ocean","revision":4}),
            ),
            (
                "PUT /api/me/colour HTTP/1.1",
                json!({"palette":"ocean"}),
                "200 OK",
                json!({"visitorId":"own","palette":"ocean","revision":5}),
            ),
            (
                "PATCH /api/me HTTP/1.1",
                json!({"name":"Bob"}),
                "409 Conflict",
                json!({"code":"name_taken","message":"another visitor has this name"}),
            ),
            (
                "PUT /api/me/colour HTTP/1.1",
                json!({"palette":"ruby"}),
                "401 Unauthorized",
                json!({"code":"visitor_required","message":"no valid visitor cookie"}),
            ),
        ];
        for (index, (request, body, status, reply)) in fixture.into_iter().enumerate() {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line.trim_end(), request);
            let mut actual_origin = String::new();
            let mut cookie = String::new();
            let mut length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).await.unwrap();
                if line == "\r\n" {
                    break;
                }
                let (name, value) = line.split_once(':').unwrap();
                match name {
                    "origin" => actual_origin = value.trim().to_owned(),
                    "cookie" => cookie = value.trim().to_owned(),
                    "content-length" => length = value.trim().parse().unwrap(),
                    _ => {}
                }
            }
            assert_eq!(actual_origin, origin);
            assert_eq!(
                cookie,
                if index == 0 {
                    ""
                } else {
                    "falky_visitor=fixture"
                }
            );
            let mut actual = vec![0; length];
            reader.read_exact(&mut actual).await.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&actual).unwrap(), body);
            let reply = reply.to_string();
            let set_cookie = if index == 0 {
                "Set-Cookie: falky_visitor=fixture; Path=/api; Secure; HttpOnly; SameSite=Strict\r\n"
            } else {
                ""
            };
            let response = format!(
                "HTTP/1.1 {status}\r\n{set_cookie}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            reader
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        }
    });

    let visitor = rename(&client, &VisitorName::parse("  Леся  ").unwrap())
        .await
        .unwrap();
    assert_eq!(visitor.name, "Леся");
    let saved = set_colour(&client, PaletteName::Ocean).await.unwrap();
    assert_eq!(saved.revision, 4);
    let repeated = set_colour(&client, PaletteName::Ocean).await.unwrap();
    assert!(repeated.revision > saved.revision && repeated.palette == saved.palette);
    let taken = rename(&client, &VisitorName::parse("Bob").unwrap())
        .await
        .unwrap_err();
    assert_eq!(taken.code(), Some("name_taken"));
    assert!(
        set_colour(&client, PaletteName::Ruby)
            .await
            .unwrap_err()
            .is_unauthorized()
    );
    server.await.unwrap();
}
