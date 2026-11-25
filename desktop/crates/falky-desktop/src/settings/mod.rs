mod prefs;
mod share;
mod view;

pub use prefs::Preferences;
pub use share::{
    ShareAudioAvailability, ShareCodec, ShareFocus, ShareFps, SharePreset, ShareResolution,
    ShareSettings, ShareStatus, ShareVolume,
};
pub use view::{Props, view, view_with_share};

use falky_core::{
    model::{PaletteName, Visitor},
    preferences::VisitorName,
    transport::ApiError,
};
use iced::keyboard::key::{Code, Physical};

use crate::ui_contract::{
    AudioDevice, AwayMinutes, KeyBinding, LanguagePreference, Shortcuts, ThemePreference,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Tab {
    #[default]
    General,
    Voice,
    Sound,
    Share,
    Profile,
    Account,
    Shortcuts,
}

impl Tab {
    const ALL: [Self; 7] = [
        Self::General,
        Self::Voice,
        Self::Sound,
        Self::Share,
        Self::Profile,
        Self::Account,
        Self::Shortcuts,
    ];

    fn uses_devices(self) -> bool {
        matches!(self, Self::Voice | Self::Sound)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioStatus {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
    pub mic_level: f32,
    pub mic_test_active: bool,
    pub speaker_test_active: bool,
    pub input_unavailable: bool,
    pub output_unavailable: bool,
    pub in_voice: bool,
    pub muted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VoiceFlag {
    NoiseSuppression,
    EchoCancellation,
    AutoGain,
    JoinMuted,
    PushToTalk,
    AwayMute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Shortcut {
    Mute,
    Deafen,
    PushToTalk,
    Leave,
}

impl Shortcut {
    const ALL: [Self; 4] = [Self::Mute, Self::Deafen, Self::PushToTalk, Self::Leave];

    fn binding(self, keys: &Shortcuts) -> &KeyBinding {
        match self {
            Self::Mute => &keys.mute,
            Self::Deafen => &keys.deafen,
            Self::PushToTalk => &keys.push_to_talk,
            Self::Leave => &keys.leave,
        }
    }

    fn set_binding(self, keys: &mut Shortcuts, binding: KeyBinding) {
        match self {
            Self::Mute => keys.mute = binding,
            Self::Deafen => keys.deafen = binding,
            Self::PushToTalk => keys.push_to_talk = binding,
            Self::Leave => keys.leave = binding,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileError {
    InvalidName,
    NameTaken,
    Network,
    Other,
}

impl From<&ApiError> for ProfileError {
    fn from(error: &ApiError) -> Self {
        match error.code() {
            Some("invalid_name") => Self::InvalidName,
            Some("name_taken") => Self::NameTaken,
            _ if matches!(error, ApiError::Transport) => Self::Network,
            _ => Self::Other,
        }
    }
}

#[derive(Clone, Debug)]
pub enum Message {
    Close,
    Tab(Tab),
    Theme(ThemePreference),
    Language(LanguagePreference),
    InputDevice(String),
    OutputDevice(String),
    VoiceFlag(VoiceFlag, bool),
    AwayMinutes(AwayMinutes),
    Chimes(bool),
    Notifications(bool),
    SharePreset(SharePreset),
    ShareSound(bool),
    ShareDetails,
    ShareResolution(ShareResolution),
    ShareFps(ShareFps),
    ShareFocus(ShareFocus),
    ShareCodec(ShareCodec),
    ShareBitrate(u8),
    MicTest,
    SpeakerTest,
    NameEdited(String),
    SaveName,
    RenameFinished(Result<(), ProfileError>),
    Colour(PaletteName),
    ColourFinished(Result<(), ProfileError>),
    SignOut,
    OpenAccessibilitySettings,
    CopyAccountId,
    Bind(Shortcut),
    Capture(Physical),
    CancelCapture,
    Reset(Shortcut),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    PreferencesChanged,
    RefreshDevices,
    MicTest(bool),
    SpeakerTest,
    Rename(VisitorName),
    SetColour(PaletteName),
    SignOut,
    OpenAccessibilitySettings,
    CopyAccountId(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum BindingError {
    Reserved,
    Taken(Shortcut),
}

#[derive(Default)]
pub struct State {
    open: bool,
    tab: Tab,
    name: Option<String>,
    name_pending: bool,
    name_error: Option<ProfileError>,
    colour_pending: Option<PaletteName>,
    colour_failed: Option<PaletteName>,
    capturing: Option<Shortcut>,
    binding_error: Option<(Shortcut, BindingError)>,
    copied_id: bool,
    share_details: Option<bool>,
}

impl State {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn tab(&self) -> Option<Tab> {
        self.open.then_some(self.tab)
    }

    pub fn is_capturing_shortcut(&self) -> bool {
        self.capturing.is_some()
    }

    pub fn open(&mut self, visitor: &Visitor) -> Option<Action> {
        if self.open {
            return None;
        }
        self.open = true;
        if visitor.name_taken {
            self.tab = Tab::Profile;
        }
        self.tab.uses_devices().then_some(Action::RefreshDevices)
    }

    pub fn close(&mut self) -> Option<Action> {
        let stop = self.open && self.tab == Tab::Voice;
        self.open = false;
        self.capturing = None;
        self.binding_error = None;
        self.copied_id = false;
        if !self.name_pending {
            self.name = None;
            self.name_error = None;
        }
        stop.then_some(Action::MicTest(false))
    }

    pub fn update(
        &mut self,
        message: Message,
        prefs: &mut Preferences,
        visitor: &Visitor,
        audio: &AudioStatus,
    ) -> Option<Action> {
        // Scoped replies can arrive after the dialog closes.
        match message {
            Message::RenameFinished(result) => {
                self.name_pending = false;
                self.name_error = result.err();
                if self.name_error.is_none() {
                    self.name = None;
                }
                return None;
            }
            Message::ColourFinished(result) => {
                let palette = self.colour_pending.take();
                self.colour_failed = if result.is_err() { palette } else { None };
                return None;
            }
            _ => {}
        }
        if !self.open {
            return None;
        }

        match message {
            Message::Close => return self.close(),
            Message::Tab(tab) => return self.select_tab(tab),
            Message::MicTest if self.tab == Tab::Voice && !audio.in_voice => {
                return Some(Action::MicTest(!audio.mic_test_active));
            }
            Message::SpeakerTest if self.tab == Tab::Sound && !audio.speaker_test_active => {
                return Some(Action::SpeakerTest);
            }
            Message::NameEdited(name) if !self.name_pending => {
                self.name = Some(name);
                self.name_error = None;
                return None;
            }
            Message::SaveName => return self.save_name(visitor),
            Message::Colour(palette) if self.colour_pending.is_none() => {
                self.colour_pending = Some(palette);
                self.colour_failed = None;
                return Some(Action::SetColour(palette));
            }
            Message::SignOut => return Some(Action::SignOut),
            Message::OpenAccessibilitySettings => return Some(Action::OpenAccessibilitySettings),
            Message::CopyAccountId => {
                self.copied_id = true;
                return Some(Action::CopyAccountId(visitor.id.to_string()));
            }
            Message::Bind(key) => {
                self.capturing = Some(key);
                self.binding_error = None;
                return None;
            }
            Message::CancelCapture => {
                self.capturing = None;
                return None;
            }
            Message::Capture(physical) => return self.capture(physical, &mut prefs.shortcuts),
            Message::Reset(key) => {
                self.capturing = None;
                self.change_binding(
                    &mut prefs.shortcuts,
                    key,
                    key.binding(&Shortcuts::default()).clone(),
                )?;
            }
            Message::Theme(value) => prefs.theme = value,
            Message::Language(value) => prefs.language = value,
            Message::InputDevice(id) => prefs.voice.mic_id = id,
            Message::OutputDevice(id) => prefs.voice.speaker_id = id,
            Message::VoiceFlag(flag, on) => match flag {
                VoiceFlag::NoiseSuppression => prefs.voice.noise_suppression = on,
                VoiceFlag::EchoCancellation => prefs.voice.echo_cancellation = on,
                VoiceFlag::AutoGain => prefs.voice.auto_gain = on,
                VoiceFlag::JoinMuted => prefs.voice.join_muted = on,
                VoiceFlag::PushToTalk => prefs.voice.push_to_talk = on,
                VoiceFlag::AwayMute => prefs.voice.away_mute = on,
            },
            Message::AwayMinutes(value) => prefs.voice.away_minutes = value,
            Message::Chimes(on) => prefs.chimes = on,
            Message::Notifications(on) => prefs.notifications = on,
            Message::ShareDetails => {
                let expanded = self.share_details.unwrap_or(prefs.share.preset().is_none());
                self.share_details = Some(!expanded);
                return None;
            }
            Message::SharePreset(value) => prefs.share.apply_preset(value),
            Message::ShareSound(value) => prefs.share.with_sound = value,
            Message::ShareResolution(value) => prefs.share.resolution = value,
            Message::ShareFps(value) => prefs.share.fps = value,
            Message::ShareFocus(value) => prefs.share.focus = value,
            Message::ShareCodec(value) => prefs.share.codec = value,
            Message::ShareBitrate(value) => {
                prefs.share.bitrate_mbps = value.min(share::MAX_BITRATE_MBPS);
            }
            _ => return None,
        }
        Some(Action::PreferencesChanged)
    }

    fn select_tab(&mut self, tab: Tab) -> Option<Action> {
        if self.tab == tab {
            return None;
        }
        let previous = std::mem::replace(&mut self.tab, tab);
        self.capturing = None;
        self.binding_error = None;
        if previous == Tab::Voice {
            return Some(Action::MicTest(false));
        }
        tab.uses_devices().then_some(Action::RefreshDevices)
    }

    fn save_name(&mut self, visitor: &Visitor) -> Option<Action> {
        if self.name_pending {
            return None;
        }
        let name = self.name.as_deref()?;
        match VisitorName::parse(name) {
            Ok(name) if name.as_str() != visitor.name => {
                self.name_pending = true;
                self.name_error = None;
                Some(Action::Rename(name))
            }
            Ok(_) => None,
            Err(_) => {
                self.name_error = Some(ProfileError::InvalidName);
                None
            }
        }
    }

    fn capture(&mut self, physical: Physical, keys: &mut Shortcuts) -> Option<Action> {
        let key = self.capturing.take()?;
        if physical == Physical::Code(Code::Escape) {
            return None;
        }
        let Some(binding) = physical_binding(physical) else {
            self.binding_error = Some((key, BindingError::Reserved));
            return None;
        };
        self.change_binding(keys, key, binding)?;
        Some(Action::PreferencesChanged)
    }

    fn change_binding(
        &mut self,
        keys: &mut Shortcuts,
        key: Shortcut,
        binding: KeyBinding,
    ) -> Option<()> {
        if let Some(by) = Shortcut::ALL
            .into_iter()
            .find(|&other| key != other && other.binding(keys).code == binding.code)
        {
            self.binding_error = Some((key, BindingError::Taken(by)));
            return None;
        }
        key.set_binding(keys, binding);
        self.binding_error = None;
        Some(())
    }
}

fn physical_binding(physical: Physical) -> Option<KeyBinding> {
    let Physical::Code(physical) = physical else {
        return None;
    };
    let code = format!("{physical:?}");
    if matches!(
        code.as_str(),
        "Slash" | "Enter" | "NumpadEnter" | "Escape" | "Tab" | "Backspace" | "CapsLock"
    ) || ["Arrow", "Meta", "Super", "Control", "Alt", "Shift"]
        .iter()
        .any(|prefix| code.starts_with(prefix))
    {
        return None;
    }
    let label = code
        .strip_prefix("Key")
        .or_else(|| code.strip_prefix("Digit"))
        .unwrap_or(&code)
        .to_owned();
    Some(KeyBinding { code, label })
}

#[cfg(test)]
mod tests;
