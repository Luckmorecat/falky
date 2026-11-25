use std::{future::Future, pin::Pin, sync::OnceLock};

use iced::window;

use falky_core::voice::ScreenCaptureSink as CaptureSink;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as native;
#[cfg(target_os = "macos")]
use macos as native;
#[cfg(target_os = "windows")]
use windows as native;

#[derive(Debug, Clone, Copy)]
pub struct Availability {
    pub video: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct CaptureOptions {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub with_audio: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum CaptureError {
    Unavailable,
    PermissionDenied,
    Failed,
}

pub type CaptureResult = Result<Option<Box<dyn Send>>, CaptureError>;
type CaptureStart = Pin<Box<dyn Future<Output = CaptureResult> + Send>>;

pub fn available() -> Availability {
    static AVAILABILITY: OnceLock<Availability> = OnceLock::new();
    *AVAILABILITY.get_or_init(native::available)
}

pub fn begin(
    window: &dyn window::Window,
    options: CaptureOptions,
    sink: CaptureSink,
) -> CaptureStart {
    let Ok(handle) = window.window_handle() else {
        return Box::pin(async { Err(CaptureError::Unavailable) });
    };
    let display = window.display_handle().ok().map(|handle| handle.as_raw());
    native::begin(handle.as_raw(), display, options, sink)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod native {
    use super::*;
    use window::raw_window_handle::{RawDisplayHandle, RawWindowHandle};

    pub(super) fn available() -> Availability {
        Availability {
            video: false,
            audio: false,
        }
    }

    pub(super) fn begin(
        _: RawWindowHandle,
        _: Option<RawDisplayHandle>,
        _: CaptureOptions,
        _: CaptureSink,
    ) -> CaptureStart {
        Box::pin(async { Err(CaptureError::Unavailable) })
    }
}
