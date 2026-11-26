//! Falky native application and platform integrations.

pub mod app;
pub mod chat;
pub mod locale;
pub mod login;
#[cfg(test)]
#[path = "../../../scoreboard/measure.rs"]
mod perf;
#[cfg(test)]
mod perf_fixture;
pub mod platform;
pub mod settings;
pub mod shell;
pub mod ui_contract;
