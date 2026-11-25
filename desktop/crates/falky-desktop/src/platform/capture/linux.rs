use std::time::Duration;

use ashpd::{
    PortalError, WindowIdentifier,
    desktop::{
        ResponseError,
        screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    },
    zbus::{self, Connection},
};
use futures_util::StreamExt;
use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
use tokio::sync::oneshot;
use wayland_client::{
    Connection as WaylandConnection, Proxy,
    backend::{Backend, ObjectId},
    protocol::wl_surface::WlSurface,
};

use super::{Availability, CaptureError, CaptureOptions, CaptureSink, CaptureStart};

mod frame;
mod pipewire;

pub(super) fn available() -> Availability {
    Availability {
        video: ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET"]
            .into_iter()
            .any(|name| std::env::var_os(name).is_some()),
        audio: false,
    }
}

pub(super) fn begin(
    window: RawWindowHandle,
    display: Option<RawDisplayHandle>,
    options: CaptureOptions,
    sink: CaptureSink,
) -> CaptureStart {
    let parent = ParentWindow::new(window, display);
    Box::pin(async move {
        let parent = parent.ok_or(CaptureError::Unavailable)?;
        let (ready, result) = oneshot::channel();
        let (lease, stop) = oneshot::channel();
        tokio::spawn(capture(parent, options, sink, ready, stop));

        match result.await.map_err(|_| CaptureError::Failed)?? {
            true => Ok(Some(Box::new(lease) as Box<dyn Send>)),
            false => Ok(None),
        }
    })
}

struct ParentWindow {
    // Drop the identifier before flushing and releasing its borrowed backend.
    identifier: WindowIdentifier,
    _wayland: Option<WaylandExportConnection>,
}

struct WaylandExportConnection(WaylandConnection);

impl Drop for WaylandExportConnection {
    fn drop(&mut self) {
        let _ = self.0.flush();
    }
}

impl ParentWindow {
    fn new(window: RawWindowHandle, display: Option<RawDisplayHandle>) -> Option<Self> {
        let identifier = match (window, display) {
            (RawWindowHandle::Xlib(window), _) if window.window != 0 => {
                WindowIdentifier::from_xid(window.window)
            }
            (RawWindowHandle::Xcb(window), _) => {
                WindowIdentifier::from_xid(window.window.get().into())
            }
            (RawWindowHandle::Wayland(window), Some(RawDisplayHandle::Wayland(display))) => {
                // SAFETY: iced lends the live surface on the UI thread and winit
                // keeps the display alive across window recreation.
                let (connection, surface_id) = unsafe {
                    let connection = WaylandConnection::from_backend(
                        Backend::from_foreign_display(display.display.as_ptr().cast()),
                    );
                    let surface_id =
                        ObjectId::from_ptr(WlSurface::interface(), window.surface.as_ptr().cast())
                            .ok()?;
                    (connection, surface_id)
                };
                let surface = WlSurface::from_id(&connection, surface_id).ok()?;
                let identifier =
                    futures_executor::block_on(WindowIdentifier::from_wayland(&surface))?;
                return (identifier.to_string() != "wayland:").then_some(Self {
                    identifier,
                    _wayland: Some(WaylandExportConnection(connection)),
                });
            }
            _ => return None,
        };
        Some(Self {
            identifier,
            _wayland: None,
        })
    }
}

async fn capture(
    parent: ParentWindow,
    options: CaptureOptions,
    sink: CaptureSink,
    ready: oneshot::Sender<Result<bool, CaptureError>>,
    mut stop: oneshot::Receiver<()>,
) {
    // The portal owns requests and sessions by bus peer. A separate connection
    // also closes an outstanding Start picker when the caller drops its future.
    let connection = tokio::select! {
        biased;
        _ = &mut stop => return,
        connection = Connection::session() => match connection {
            Ok(connection) => connection,
            Err(_) => {
                let _ = ready.send(Err(CaptureError::Unavailable));
                return;
            }
        },
    };

    let mut ready = Some(ready);
    let result = tokio::select! {
        biased;
        _ = &mut stop => None,
        result = run(&connection, parent, options, &sink, &mut ready) => Some(result),
    };
    let _ = connection.close().await;
    if let Some(result) = result {
        if let Some(ready) = ready {
            let _ = ready.send(result);
        } else if matches!(result, Ok(true))
            && matches!(stop.try_recv(), Err(oneshot::error::TryRecvError::Empty))
        {
            sink.source_lost();
        }
    }
}

async fn run(
    connection: &Connection,
    parent: ParentWindow,
    options: CaptureOptions,
    sink: &CaptureSink,
    ready: &mut Option<oneshot::Sender<Result<bool, CaptureError>>>,
) -> Result<bool, CaptureError> {
    let portal = Screencast::with_connection(connection.clone())
        .await
        .map_err(portal_error)?;
    let source_types = portal
        .available_source_types()
        .await
        .map_err(portal_error)?
        & (SourceType::MONITOR | SourceType::WINDOW);
    if source_types.is_empty() {
        return Err(CaptureError::Unavailable);
    }
    let cursor_mode = if portal
        .available_cursor_modes()
        .await
        .is_ok_and(|modes| modes.contains(CursorMode::EMBEDDED))
    {
        Some(CursorMode::EMBEDDED)
    } else {
        None
    };
    let session = portal
        .create_session(Default::default())
        .await
        .map_err(portal_error)?;
    let mut closed = session.receive_closed().await.map_err(portal_error)?;
    let selection = async {
        portal
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_sources(source_types)
                    .set_multiple(false)
                    .set_cursor_mode(cursor_mode),
            )
            .await?
            .response()?;
        portal
            .start(&session, Some(&parent.identifier), Default::default())
            .await?
            .response()
    };
    let streams = tokio::select! {
        biased;
        result = selection => match result {
            Ok(streams) => streams,
            Err(ashpd::Error::Response(ResponseError::Cancelled)
                | ashpd::Error::Portal(PortalError::Cancelled(_))) => return Ok(false),
            Err(error) => return Err(portal_error(error)),
        },
        _ = closed.next() => return Err(CaptureError::Failed),
    };
    drop(parent);
    let [source] = streams.streams() else {
        return Err(CaptureError::Failed);
    };
    let remote = portal
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(portal_error)?;
    let mut capture = pipewire::Capture::start(
        remote,
        source.pipe_wire_node_id(),
        source.pipewire_serial(),
        options,
        sink.clone(),
    )?;
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(10), capture.ready()) => {
            result.map_err(|_| CaptureError::Failed)??;
        },
        _ = closed.next() => return Err(CaptureError::Failed),
    }

    let Some(ready) = ready.take() else {
        return Err(CaptureError::Failed);
    };
    if ready.send(Ok(true)).is_err() {
        return Ok(false);
    }
    tokio::select! {
        _ = closed.next() => {}
        _ = capture.stopped() => {}
    }
    Ok(true)
}

fn portal_error(error: ashpd::Error) -> CaptureError {
    use ashpd::Error::{Portal, PortalNotFound, RequiresVersion, Zbus};

    match error {
        Portal(PortalError::NotAllowed(_)) => CaptureError::PermissionDenied,
        PortalNotFound(_) | RequiresVersion(..) => CaptureError::Unavailable,
        Portal(PortalError::ZBus(error)) | Zbus(error) => match zbus::fdo::Error::from(error) {
            zbus::fdo::Error::AccessDenied(_) => CaptureError::PermissionDenied,
            zbus::fdo::Error::ServiceUnknown(_)
            | zbus::fdo::Error::UnknownInterface(_)
            | zbus::fdo::Error::UnknownMethod(_)
            | zbus::fdo::Error::UnknownProperty(_) => CaptureError::Unavailable,
            _ => CaptureError::Failed,
        },
        _ => CaptureError::Failed,
    }
}
