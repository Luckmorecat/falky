use falky_core::model::{ConnectionId, PaletteName, RoomId, VisitorId};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    Dark,
    Light,
    System,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EffectiveTheme {
    #[default]
    Dark,
    Light,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LanguagePreference {
    #[default]
    System,
    En,
    Uk,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Language {
    #[default]
    En,
    Uk,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum AwayMinutes {
    Five,
    #[default]
    Ten,
    Thirty,
}

impl AwayMinutes {
    pub fn duration(self) -> Duration {
        Duration::from_secs(
            60 * match self {
                Self::Five => 5,
                Self::Ten => 10,
                Self::Thirty => 30,
            },
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VoiceSettings {
    pub mic_id: String,
    pub speaker_id: String,
    pub noise_suppression: bool,
    pub echo_cancellation: bool,
    pub auto_gain: bool,
    pub join_muted: bool,
    pub push_to_talk: bool,
    pub away_mute: bool,
    pub away_minutes: AwayMinutes,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            mic_id: String::new(),
            speaker_id: String::new(),
            noise_suppression: true,
            echo_cancellation: true,
            auto_gain: true,
            join_muted: false,
            push_to_talk: false,
            away_mute: true,
            away_minutes: AwayMinutes::Ten,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GlobalPttStatus {
    #[default]
    Inactive,
    Available,
    AccessibilityRequired,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PttSource {
    Global,
    Window,
    Dock,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PttAction {
    pub source: PttSource,
    pub pressed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct KeyBinding {
    pub code: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Shortcuts {
    pub mute: KeyBinding,
    pub deafen: KeyBinding,
    pub leave: KeyBinding,
    pub push_to_talk: KeyBinding,
}

impl Default for Shortcuts {
    fn default() -> Self {
        let binding = |code: &str, label: &str| KeyBinding {
            code: code.into(),
            label: label.into(),
        };
        Self {
            mute: binding("KeyM", "M"),
            deafen: binding("KeyD", "D"),
            leave: binding("KeyL", "L"),
            push_to_talk: binding("Space", "Space"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoiceAction {
    Join(RoomId),
    Leave,
    ToggleMute,
    ToggleDeafen,
    PushToTalk(PttAction),
    SetGain {
        connection_id: ConnectionId,
        percent: u16,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayAction {
    Show,
    Hide,
    ToggleMute,
    ToggleDeafen,
    StopSharing,
    LeaveVoice,
    Quit,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct VoiceStatus {
    pub room: Option<RoomId>,
    pub joining: Option<RoomId>,
    pub muted: bool,
    pub deafened: bool,
    pub ptt_held: bool,
    pub listen_only: bool,
    pub mic_level: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StageParticipant<'a> {
    pub connection_id: &'a ConnectionId,
    pub visitor_id: &'a VisitorId,
    pub name: &'a str,
    pub palette: PaletteName,
    pub local: bool,
    pub muted: bool,
    pub deafened: bool,
    pub speaking: bool,
    pub level: f32,
    pub camera: bool,
    pub screen_share: bool,
    pub gain_percent: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoomIndicator {
    pub id: RoomId,
    pub name: String,
    pub occupancy: usize,
    pub viewed: bool,
    pub in_voice: bool,
    pub unread: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TickerItem {
    pub author: String,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct ShellInput<'a> {
    pub theme: EffectiveTheme,
    pub language: Language,
    pub rooms: &'a [RoomIndicator],
    pub stage: &'a [StageParticipant<'a>],
    pub voice: &'a VoiceStatus,
    pub ticker: &'a [TickerItem],
    pub chat_open: bool,
    pub viewport: Viewport,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellAction {
    ViewRoom(RoomId),
    ToggleChat,
    OpenSettings,
    Voice(VoiceAction),
}
