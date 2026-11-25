use crate::transport::WebSocket;
use futures_util::{
    SinkExt, StreamExt,
    future::BoxFuture,
    stream::{SplitSink, SplitStream},
};
use livekit_net::{Header, TransportError, WsClient, WsConnectResult, WsConnection};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{sync::Mutex, time::timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Error as WsError, Message, client::IntoClientRequest, error::ProtocolError, http,
    },
};
use url::Url;

struct DirectSocket {
    send: Mutex<SplitSink<WebSocket, Message>>,
    recv: Mutex<SplitStream<WebSocket>>,
}

impl WsConnection for DirectSocket {
    fn send<'a, 'f>(&'a self, frame: Vec<u8>) -> BoxFuture<'f, Result<(), TransportError>>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            self.send
                .lock()
                .await
                .send(Message::Binary(frame.into()))
                .await
                .map_err(map_ws)
        })
    }

    fn recv<'a, 'f>(&'a self) -> BoxFuture<'f, Result<Option<Vec<u8>>, TransportError>>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let mut reader = self.recv.lock().await;
            loop {
                match reader.next().await {
                    Some(Ok(Message::Binary(bytes))) => return Ok(Some(bytes.to_vec())),
                    Some(Ok(Message::Ping(_))) => {
                        self.send.lock().await.flush().await.map_err(map_ws)?;
                    }
                    Some(Ok(Message::Close(_))) => {
                        let _ = self.send.lock().await.flush().await;
                        return Ok(None);
                    }
                    None
                    | Some(Err(
                        WsError::ConnectionClosed
                        | WsError::AlreadyClosed
                        | WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake),
                    )) => return Ok(None),
                    Some(Err(WsError::Io(ref error)))
                        if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        return Ok(None);
                    }
                    Some(Err(error)) => return Err(map_ws(error)),
                    _ => {}
                }
            }
        })
    }

    fn close<'a, 'f>(&'a self) -> BoxFuture<'f, ()>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async {
            let _ = self.send.lock().await.close().await;
        })
    }
}

fn map_ws(error: WsError) -> TransportError {
    match error {
        WsError::Http(response) => TransportError::Http {
            status: response.status().as_u16(),
        },
        WsError::ConnectionClosed | WsError::AlreadyClosed => TransportError::Closed,
        _ => TransportError::Connection("LiveKit signalling socket failed".into()),
    }
}

struct SelectiveWs(Arc<dyn WsClient>);

impl WsClient for SelectiveWs {
    fn connect<'a, 'f>(
        &'a self,
        url: String,
        headers: Vec<Header>,
        timeout_ms: u64,
    ) -> BoxFuture<'f, Result<WsConnectResult, TransportError>>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let Ok(parsed) = Url::parse(&url) else {
                return self.0.connect(url, headers, timeout_ms).await;
            };
            if !local_socket(&parsed) {
                return self.0.connect(url, headers, timeout_ms).await;
            }

            let mut request = parsed.into_client_request().map_err(map_ws)?;
            for header in headers {
                let name = http::HeaderName::try_from(header.name)
                    .map_err(|_| TransportError::Other("invalid signalling header name".into()))?;
                let value = http::HeaderValue::try_from(header.value)
                    .map_err(|_| TransportError::Other("invalid signalling header value".into()))?;
                request.headers_mut().insert(name, value);
            }
            let (socket, _) = timeout(Duration::from_millis(timeout_ms), connect_async(request))
                .await
                .map_err(|_| TransportError::Timeout)?
                .map_err(map_ws)?;
            let (send, recv) = socket.split();
            Ok(WsConnectResult {
                connection: Arc::new(DirectSocket {
                    send: Mutex::new(send),
                    recv: Mutex::new(recv),
                }),
            })
        })
    }
}

fn local_socket(url: &Url) -> bool {
    matches!(url.scheme(), "ws" | "wss")
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        && url.username().is_empty()
        && url.password().is_none()
}

pub(super) fn register() {
    static REGISTERED: OnceLock<()> = OnceLock::new();
    REGISTERED.get_or_init(|| {
        // livekit-net 0.2.0 does not apply NO_PROXY to WebSocket signalling.
        if let Some(upstream) = livekit_net::ws_client() {
            livekit_net::set_ws_client(Arc::new(SelectiveWs(upstream)));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bypass_is_limited_to_the_two_approved_loopback_hosts() {
        for url in ["wss://localhost:4443/rtc/v1", "ws://127.0.0.1/rtc"] {
            assert!(local_socket(&Url::parse(url).unwrap()));
        }
        for url in [
            "ws://127.0.0.2/rtc",
            "ws://[::1]/rtc",
            "ws://localhost.example/rtc",
            "ws://localhost./rtc",
            "ws://user@localhost/rtc",
            "https://localhost/rtc",
        ] {
            assert!(!local_socket(&Url::parse(url).unwrap()));
        }
    }

    #[tokio::test]
    #[allow(
        clippy::result_large_err,
        reason = "Tungstenite's handshake callback fixes the error type"
    )]
    async fn loopback_stream_preserves_upgrade_headers_binary_and_control_frames() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::{
            accept_hdr_async,
            tungstenite::handshake::server::{Request, Response},
        };

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(stream, |req: &Request, response: Response| {
                assert_eq!(
                    req.uri().path_and_query().unwrap().as_str(),
                    "/rtc?fixture=1"
                );
                assert_eq!(req.headers()["x-fixture"], "header");
                Ok(response)
            })
            .await
            .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Binary(vec![1, 2].into())
            );
            socket.send(Message::Ping(vec![3].into())).await.unwrap();
            socket
                .send(Message::Binary(vec![4, 5].into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap(),
                Message::Pong(vec![3].into())
            );
            socket.close(None).await.unwrap();
        });
        let ws = SelectiveWs(Arc::new(Upstream));
        let local = ws
            .connect(
                format!("ws://{address}/rtc?fixture=1"),
                vec![Header {
                    name: "x-fixture".into(),
                    value: "header".into(),
                }],
                3000,
            )
            .await
            .unwrap()
            .connection;
        local.send(vec![1, 2]).await.unwrap();
        assert_eq!(local.recv().await.unwrap(), Some(vec![4, 5]));
        assert_eq!(local.recv().await.unwrap(), None);
        server.await.unwrap();
    }

    struct Upstream;
    impl WsClient for Upstream {
        fn connect<'a, 'f>(
            &'a self,
            url: String,
            headers: Vec<Header>,
            timeout_ms: u64,
        ) -> BoxFuture<'f, Result<WsConnectResult, TransportError>>
        where
            'a: 'f,
            Self: 'f,
        {
            Box::pin(async move {
                assert_eq!(url, "wss://falky.example/rtc/v1?join_request=fixture");
                assert_eq!(headers[0].name, "fixture-header");
                assert_eq!(headers[0].value, "fixture");
                assert_eq!(timeout_ms, 321);
                Err(TransportError::Http { status: 403 })
            })
        }
    }

    #[tokio::test]
    async fn remote_socket_retains_the_upstream_request_and_response() {
        let ws = SelectiveWs(Arc::new(Upstream));
        let result = ws
            .connect(
                "wss://falky.example/rtc/v1?join_request=fixture".into(),
                vec![Header {
                    name: "fixture-header".into(),
                    value: "fixture".into(),
                }],
                321,
            )
            .await;
        assert!(matches!(result, Err(TransportError::Http { status: 403 })));
    }
}
