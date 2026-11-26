//! Portable Falky protocol and application state.

pub mod attachments;
#[cfg(feature = "native-audio")]
pub mod audio;
pub mod chat;
pub mod live;
pub mod model;
#[cfg(all(test, feature = "native-audio"))]
#[path = "../../../scoreboard/measure.rs"]
mod perf;
pub mod preferences;
pub mod session;
pub mod transport;
#[cfg(feature = "native-audio")]
pub mod voice;

pub use transport::{ApiClient, ApiError, Origin, OriginError};
