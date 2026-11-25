use serde::{Deserialize, Serialize};

use super::prefs::normalized_gain;

pub const MAX_BITRATE_MBPS: u8 = 20;
pub const BITRATE_PRESETS_MBPS: [u8; 5] = [0, 3, 6, 10, MAX_BITRATE_MBPS];

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum ShareResolution {
    #[serde(rename = "720")]
    P720,
    #[default]
    #[serde(rename = "1080")]
    P1080,
    #[serde(rename = "1440")]
    P1440,
}

impl ShareResolution {
    pub const ALL: [Self; 3] = [Self::P720, Self::P1080, Self::P1440];

    pub const fn height(self) -> u32 {
        match self {
            Self::P720 => 720,
            Self::P1080 => 1080,
            Self::P1440 => 1440,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum ShareFps {
    #[serde(rename = "15")]
    Fifteen,
    #[default]
    #[serde(rename = "30")]
    Thirty,
    #[serde(rename = "60")]
    Sixty,
}

impl ShareFps {
    pub const ALL: [Self; 3] = [Self::Fifteen, Self::Thirty, Self::Sixty];

    pub const fn value(self) -> u32 {
        match self {
            Self::Fifteen => 15,
            Self::Thirty => 30,
            Self::Sixty => 60,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareFocus {
    #[default]
    Motion,
    Detail,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareCodec {
    H264,
    Vp9,
    Av1,
    H265,
    #[default]
    #[serde(other)]
    Vp8,
}

impl ShareCodec {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Vp8 => "VP8",
            Self::H264 => "H.264",
            Self::Vp9 => "VP9",
            Self::Av1 => "AV1",
            Self::H265 => "H.265",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SharePreset {
    Docs,
    Games,
    Video,
}

impl SharePreset {
    pub const ALL: [Self; 3] = [Self::Docs, Self::Games, Self::Video];

    const fn values(self) -> (ShareResolution, ShareFps, ShareFocus) {
        match self {
            Self::Docs => (
                ShareResolution::P1440,
                ShareFps::Fifteen,
                ShareFocus::Detail,
            ),
            Self::Games => (ShareResolution::P1080, ShareFps::Sixty, ShareFocus::Motion),
            Self::Video => (ShareResolution::P1080, ShareFps::Thirty, ShareFocus::Motion),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShareSettings {
    pub resolution: ShareResolution,
    pub fps: ShareFps,
    pub focus: ShareFocus,
    pub codec: ShareCodec,
    pub with_sound: bool,
    pub bitrate_mbps: u8,
}

impl Default for ShareSettings {
    fn default() -> Self {
        Self {
            resolution: ShareResolution::default(),
            fps: ShareFps::default(),
            focus: ShareFocus::default(),
            codec: ShareCodec::default(),
            with_sound: true,
            bitrate_mbps: 0,
        }
    }
}

impl ShareSettings {
    pub fn apply_preset(&mut self, preset: SharePreset) {
        (self.resolution, self.fps, self.focus) = preset.values();
    }

    pub fn preset(self) -> Option<SharePreset> {
        SharePreset::ALL
            .into_iter()
            .find(|preset| preset.values() == (self.resolution, self.fps, self.focus))
    }

    pub const fn dimensions(self) -> (u32, u32) {
        let height = self.resolution.height();
        ((height * 16 + 4) / 9, height)
    }

    pub fn resolved_codec(self, codecs: &[ShareCodec]) -> ShareCodec {
        if codecs.contains(&self.codec) {
            self.codec
        } else {
            ShareCodec::Vp8
        }
    }

    pub fn bitrate_bps(self) -> u64 {
        let fixed = self.bitrate_mbps.min(MAX_BITRATE_MBPS);
        if fixed > 0 {
            return u64::from(fixed) * 1_000_000;
        }
        let at_thirty = match self.resolution {
            ShareResolution::P720 => 2_500_000,
            ShareResolution::P1080 => 5_000_000,
            ShareResolution::P1440 => 8_000_000,
        };
        match self.fps {
            ShareFps::Fifteen => at_thirty * 7 / 10,
            ShareFps::Thirty => at_thirty,
            ShareFps::Sixty => at_thirty * 3 / 2,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShareVolume {
    last_nonzero: u16,
    muted: bool,
}

impl Default for ShareVolume {
    fn default() -> Self {
        Self {
            last_nonzero: 100,
            muted: false,
        }
    }
}

impl ShareVolume {
    pub fn percent(self) -> u16 {
        if self.muted {
            0
        } else {
            match normalized_gain(self.last_nonzero) {
                0 => 100,
                percent => percent,
            }
        }
    }

    pub fn set_percent(&mut self, percent: u16) {
        let percent = normalized_gain(percent);
        self.muted = percent == 0;
        if !self.muted {
            self.last_nonzero = percent;
        }
    }

    pub fn toggle_mute(&mut self) {
        self.muted = !self.muted;
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ShareAudioAvailability {
    Available,
    WindowsSystemAudio,
    LinuxUnavailable,
    MacosUnavailable,
    WindowsUnavailable,
    #[default]
    Unavailable,
}

impl ShareAudioAvailability {
    pub const fn supports_sound(self) -> bool {
        matches!(self, Self::Available | Self::WindowsSystemAudio)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ShareStatus<'a> {
    pub audio: ShareAudioAvailability,
    pub capture_available: bool,
    pub sharing: bool,
    pub codecs: &'a [ShareCodec],
}

impl Default for ShareStatus<'_> {
    fn default() -> Self {
        Self {
            audio: ShareAudioAvailability::default(),
            capture_available: true,
            sharing: false,
            codecs: &[ShareCodec::Vp8],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_change_only_quality_and_match_automatic_bitrate() {
        let mut settings = ShareSettings {
            codec: ShareCodec::H264,
            with_sound: false,
            ..ShareSettings::default()
        };
        for (preset, size, fps, focus, bps) in [
            (
                SharePreset::Docs,
                (2560, 1440),
                15,
                ShareFocus::Detail,
                5_600_000,
            ),
            (
                SharePreset::Games,
                (1920, 1080),
                60,
                ShareFocus::Motion,
                7_500_000,
            ),
            (
                SharePreset::Video,
                (1920, 1080),
                30,
                ShareFocus::Motion,
                5_000_000,
            ),
        ] {
            settings.apply_preset(preset);
            assert_eq!(settings.preset(), Some(preset));
            assert_eq!(settings.dimensions(), size);
            assert_eq!(settings.fps.value(), fps);
            assert_eq!(settings.focus, focus);
            assert_eq!(settings.codec, ShareCodec::H264);
            assert!(!settings.with_sound);
            assert_eq!(settings.bitrate_bps(), bps);
        }
        settings.bitrate_mbps = 12;
        settings.apply_preset(SharePreset::Docs);
        assert_eq!(settings.bitrate_bps(), 12_000_000);
    }

    #[test]
    fn unavailable_saved_codecs_fall_back_without_changing_other_options() {
        let persisted: ShareSettings =
            serde_json::from_str(r#"{"codec":"future","withSound":false}"#).unwrap();
        assert_eq!(persisted.codec, ShareCodec::Vp8);
        assert!(!persisted.with_sound);
        let saved = ShareSettings {
            codec: ShareCodec::H265,
            ..ShareSettings::default()
        };
        assert_eq!(saved.resolved_codec(&[ShareCodec::Vp8]), ShareCodec::Vp8);
        assert_eq!(
            saved.resolved_codec(&[ShareCodec::Vp8, ShareCodec::H265]),
            ShareCodec::H265
        );
    }
}
