use std::{collections::BTreeMap, path::Path};

use falky_core::{
    model::ConnectionId,
    preferences::{PreferenceFileError, PreferenceStore},
    transport::Origin,
};
use serde::{Deserialize, Serialize};

use crate::ui_contract::{LanguagePreference, Shortcuts, ThemePreference, VoiceSettings};

use super::share::{ShareSettings, ShareVolume};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub theme: ThemePreference,
    pub language: LanguagePreference,
    pub simplified_orbs: bool,
    pub voice: VoiceSettings,
    pub chimes: bool,
    pub notifications: bool,
    pub shortcuts: Shortcuts,
    pub share: ShareSettings,
    pub share_volume: ShareVolume,
    gains: BTreeMap<String, BTreeMap<ConnectionId, u16>>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            language: LanguagePreference::default(),
            simplified_orbs: false,
            voice: VoiceSettings::default(),
            chimes: true,
            notifications: false,
            shortcuts: Shortcuts::default(),
            share: ShareSettings::default(),
            share_volume: ShareVolume::default(),
            gains: BTreeMap::new(),
        }
    }
}

impl Preferences {
    pub fn load() -> Result<Self, PreferenceFileError> {
        PreferenceStore::platform()?.load()
    }

    pub fn save(&self) -> Result<(), PreferenceFileError> {
        PreferenceStore::platform()?.save(self)
    }

    pub fn load_from(path: &Path) -> Result<Self, PreferenceFileError> {
        PreferenceStore::at(path).load()
    }

    pub fn save_to(&self, path: &Path) -> Result<(), PreferenceFileError> {
        PreferenceStore::at(path).save(self)
    }

    pub fn gains(&self, origin: &Origin) -> impl Iterator<Item = (&ConnectionId, u16)> {
        self.gains
            .get(origin.as_str())
            .into_iter()
            .flatten()
            .map(|(id, gain)| (id, normalized_gain(*gain)))
    }

    pub fn set_gain(&mut self, origin: &Origin, id: ConnectionId, percent: u16) {
        let origin = origin.as_str();
        let percent = normalized_gain(percent);
        if percent == 100 {
            if let Some(gains) = self.gains.get_mut(origin) {
                gains.remove(&id);
            }
        } else {
            self.gains
                .entry(origin.to_owned())
                .or_default()
                .insert(id, percent);
        }
    }
}

pub(super) fn normalized_gain(percent: u16) -> u16 {
    ((percent.min(200) + 2) / 5) * 5
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui_contract::{AwayMinutes, KeyBinding};

    #[test]
    fn preferences_survive_restart_and_only_store_local_choices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let mut prefs = Preferences::load_from(&path).unwrap();
        assert_eq!(prefs.theme, ThemePreference::Dark);
        assert_eq!(prefs.language, LanguagePreference::System);
        assert!(!prefs.simplified_orbs);
        assert!(prefs.chimes && !prefs.notifications);
        assert!(prefs.voice.away_mute && prefs.voice.echo_cancellation);
        prefs.theme = ThemePreference::Light;
        prefs.language = LanguagePreference::Uk;
        prefs.simplified_orbs = true;
        prefs.voice.mic_id = "USB audio".into();
        prefs.voice.away_minutes = AwayMinutes::Five;
        prefs.shortcuts.mute = KeyBinding {
            code: "KeyQ".into(),
            label: "Q".into(),
        };
        prefs.notifications = true;
        let own = Origin::parse("https://falky.example").unwrap();
        let other = Origin::parse("https://other.example").unwrap();
        prefs.set_gain(&own, "participant".into(), 178);
        prefs.save_to(&path).unwrap();
        let restarted = Preferences::load_from(&path).unwrap();
        assert_eq!(restarted, prefs);
        assert_eq!(restarted.gains(&own).next().unwrap().1, 180);
        assert_eq!(restarted.gains(&other).count(), 0);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["simplifiedOrbs"], true);
        assert_eq!(json.as_object().unwrap().len(), 10);
    }

    #[test]
    fn missing_groups_and_future_fields_can_be_loaded() {
        let prefs: Preferences = serde_json::from_str(r#"{"theme":"system","future":{}}"#).unwrap();
        assert_eq!(
            prefs,
            Preferences {
                theme: ThemePreference::System,
                ..Preferences::default()
            }
        );
    }

    #[test]
    fn share_preferences_load_old_files_and_remember_gain_through_mute() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        std::fs::write(&path, r#"{"theme":"light","notifications":true}"#).unwrap();
        let mut prefs = Preferences::load_from(&path).unwrap();
        assert_eq!(prefs.theme, ThemePreference::Light);
        assert!(prefs.notifications);
        assert_eq!(prefs.share, super::super::ShareSettings::default());
        assert_eq!(prefs.share_volume.percent(), 100);

        prefs.share.apply_preset(super::super::SharePreset::Games);
        prefs.share.with_sound = false;
        prefs.share.bitrate_mbps = 12;
        prefs.share_volume.set_percent(178);
        prefs.share_volume.set_percent(0);
        prefs.save_to(&path).unwrap();
        let mut restored = Preferences::load_from(&path).unwrap();
        assert_eq!(restored.share, prefs.share);
        assert_eq!(restored.share_volume.percent(), 0);
        restored.share_volume.toggle_mute();
        assert_eq!(restored.share_volume.percent(), 180);
        restored.share_volume.toggle_mute();
        restored.share_volume.set_percent(104);
        assert_eq!(restored.share_volume.percent(), 105);
    }
}
