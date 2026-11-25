mod profile;
mod store;

pub use profile::{InvalidVisitorName, VisitorName, rename, set_colour};
pub use store::{PreferenceFileError, PreferenceStore};
