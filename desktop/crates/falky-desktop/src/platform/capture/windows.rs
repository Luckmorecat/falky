mod audio;
mod video;

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
use tokio::sync::oneshot;
use windows::{
    Graphics::Capture::{GraphicsCaptureItem, GraphicsCapturePicker, GraphicsCaptureSession},
    Win32::{
        Foundation::{
            E_ACCESSDENIED, E_NOTIMPL, ERROR_CANCELLED, ERROR_NOT_SUPPORTED, HWND,
            REGDB_E_CLASSNOTREG, RPC_E_CHANGED_MODE,
        },
        Graphics::Dxgi::DXGI_ERROR_UNSUPPORTED,
        System::WinRT::{
            RO_INIT_MULTITHREADED, RO_INIT_SINGLETHREADED, RO_INIT_TYPE, RoInitialize,
            RoUninitialize,
        },
        UI::Shell::IInitializeWithWindow,
    },
    core::{AgileReference, Error, Interface},
};
use windows_future::{AsyncOperationCompletedHandler, AsyncStatus, IAsyncOperation};
use windows_version::OsVersion;

use super::{Availability, CaptureError, CaptureOptions, CaptureSink, CaptureStart};

const VIDEO_MINIMUM_BUILD: u32 = 18362;
const AUDIO_MINIMUM_BUILD: u32 = 20348;

pub(super) fn available() -> Availability {
    let build = OsVersion::current().build;
    let video = build >= VIDEO_MINIMUM_BUILD
        && current_apartment()
            .is_ok_and(|_apartment| GraphicsCaptureSession::IsSupported().unwrap_or(false));
    Availability {
        video,
        audio: video && build >= AUDIO_MINIMUM_BUILD,
    }
}

pub(super) fn begin(
    window: RawWindowHandle,
    _: Option<RawDisplayHandle>,
    options: CaptureOptions,
    sink: CaptureSink,
) -> CaptureStart {
    let RawWindowHandle::Win32(window) = window else {
        return Box::pin(async { Err(CaptureError::Unavailable) });
    };
    let allowed = available();
    if !allowed.video {
        return Box::pin(async { Err(CaptureError::Unavailable) });
    }

    let picker = open_picker(HWND(window.hwnd.get() as _)).map_err(report_error);
    Box::pin(async move {
        let (mut picker, selected) = picker?;
        let selection = selected.await;
        picker.operation = None;
        drop(picker);
        let Some(item) = selection.map_err(|_| CaptureError::Failed)?? else {
            return Ok(None);
        };
        let session = video::start(item, options, allowed.audio, sink).await?;
        Ok(Some(Box::new(session) as Box<dyn Send>))
    })
}

type Selection = Result<Option<GraphicsCaptureItem>, CaptureError>;

struct PendingPicker {
    operation: Option<AgileReference<IAsyncOperation<GraphicsCaptureItem>>>,
    _picker: GraphicsCapturePicker,
}

impl Drop for PendingPicker {
    fn drop(&mut self) {
        if let Some(operation) = self.operation.take() {
            // Cancellation can marshal back to the UI apartment.
            let _ = thread::Builder::new().spawn(move || {
                if let Ok(_apartment) = Apartment::new(RO_INIT_MULTITHREADED)
                    && let Ok(operation) = operation.resolve()
                {
                    let _ = operation.Cancel();
                }
            });
        }
    }
}

fn open_picker(hwnd: HWND) -> windows::core::Result<(PendingPicker, oneshot::Receiver<Selection>)> {
    let _apartment = Apartment::new(RO_INIT_SINGLETHREADED)?;
    let picker = GraphicsCapturePicker::new()?;
    unsafe { picker.cast::<IInitializeWithWindow>()?.Initialize(hwnd)? };
    let operation = picker.PickSingleItemAsync()?;
    let reference = AgileReference::new(&operation).inspect_err(|_| {
        let _ = operation.Cancel();
    })?;
    let pending = PendingPicker {
        operation: Some(reference),
        _picker: picker,
    };

    let (sender, selected) = oneshot::channel();
    let sender = Mutex::new(Some(sender));
    operation.SetCompleted(&AsyncOperationCompletedHandler::new(
        move |operation, status| {
            let sender = sender.lock().unwrap().take();
            if let Some(sender) = sender.filter(|sender| !sender.is_closed()) {
                let result = match status {
                    AsyncStatus::Canceled => Ok(None),
                    _ => match operation.ok().and_then(|operation| operation.GetResults()) {
                        Ok(item) => Ok(Some(item)),
                        // WinRT returns a successful null item when the picker is dismissed.
                        Err(error)
                            if error.code().is_ok()
                                || error.code() == ERROR_CANCELLED.to_hresult() =>
                        {
                            Ok(None)
                        }
                        Err(error) => Err(report_error(error)),
                    },
                };
                let _ = sender.send(result);
            }
            Ok(())
        },
    ))?;
    Ok((pending, selected))
}

struct Apartment;

impl Apartment {
    fn new(kind: RO_INIT_TYPE) -> windows::core::Result<Self> {
        unsafe { RoInitialize(kind)? };
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn current_apartment() -> windows::core::Result<Apartment> {
    Apartment::new(RO_INIT_MULTITHREADED).or_else(|error| {
        if error.code() == RPC_E_CHANGED_MODE {
            Apartment::new(RO_INIT_SINGLETHREADED)
        } else {
            Err(error)
        }
    })
}

struct Stop {
    stopped: AtomicBool,
    wake: mpsc::SyncSender<()>,
}

impl Stop {
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }

    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
}

struct Session(Arc<Stop>);

impl Drop for Session {
    fn drop(&mut self) {
        self.0.stop();
    }
}

fn report_error(error: Error) -> CaptureError {
    eprintln!("Falky Windows screen capture: {error}");
    match error.code() {
        E_ACCESSDENIED => CaptureError::PermissionDenied,
        E_NOTIMPL | REGDB_E_CLASSNOTREG | DXGI_ERROR_UNSUPPORTED => CaptureError::Unavailable,
        code if code == ERROR_NOT_SUPPORTED.to_hresult() => CaptureError::Unavailable,
        _ => CaptureError::Failed,
    }
}
