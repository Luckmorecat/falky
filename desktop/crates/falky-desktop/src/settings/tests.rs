use super::*;
use falky_core::model::VisitorColour;

fn visitor() -> Visitor {
    Visitor {
        id: "own".into(),
        name: "Ada".into(),
        name_taken: false,
        colour: VisitorColour {
            visitor_id: "own".into(),
            palette: PaletteName::Sky,
            revision: 1,
        },
    }
}

#[test]
fn simplified_orbs_toggle_is_a_local_preference() {
    let mut state = State::default();
    let mut prefs = Preferences::default();
    let visitor = visitor();
    let audio = AudioStatus::default();
    state.open(&visitor);

    for enabled in [true, false] {
        assert_eq!(
            state.update(
                Message::SimplifiedOrbs(enabled),
                &mut prefs,
                &visitor,
                &audio
            ),
            Some(Action::PreferencesChanged)
        );
        assert_eq!(prefs.simplified_orbs, enabled);
    }
}

#[test]
fn voice_settings_and_audio_test_are_routed_and_test_stops_on_close() {
    let mut state = State::default();
    let mut prefs = Preferences::default();
    let visitor = visitor();
    let audio = AudioStatus::default();
    state.open(&visitor);
    let mut update = |message| state.update(message, &mut prefs, &visitor, &audio);
    assert_eq!(
        update(Message::Tab(Tab::Voice)),
        Some(Action::RefreshDevices)
    );
    assert_eq!(update(Message::MicTest), Some(Action::MicTest(true)));
    assert_eq!(
        update(Message::VoiceFlag(VoiceFlag::AutoGain, false)),
        Some(Action::PreferencesChanged)
    );
    assert_eq!(
        update(Message::Tab(Tab::Sound)),
        Some(Action::MicTest(false))
    );
    assert_eq!(update(Message::SpeakerTest), Some(Action::SpeakerTest));
    assert_eq!(
        update(Message::Tab(Tab::Voice)),
        Some(Action::RefreshDevices)
    );
    assert_eq!(update(Message::Close), Some(Action::MicTest(false)));
    assert!(!prefs.voice.auto_gain);
    assert_eq!(state.tab(), None);
    assert_eq!(state.open(&visitor), Some(Action::RefreshDevices));
    assert_eq!(state.tab(), Some(Tab::Voice));
}

#[test]
fn profile_confirmation_and_retry_follow_the_scoped_reply() {
    let mut state = State::default();
    let mut prefs = Preferences::default();
    let visitor = visitor();
    let audio = AudioStatus::default();
    state.open(&visitor);
    let mut update = |message| state.update(message, &mut prefs, &visitor, &audio);
    update(Message::Tab(Tab::Profile));
    update(Message::NameEdited("  Хана  ".into()));
    assert_eq!(
        update(Message::SaveName),
        Some(Action::Rename(VisitorName::parse("Хана").unwrap()))
    );
    assert_eq!(update(Message::SaveName), None);
    update(Message::RenameFinished(Err(ProfileError::NameTaken)));
    assert_eq!(
        update(Message::SaveName),
        Some(Action::Rename(VisitorName::parse("Хана").unwrap()))
    );
    update(Message::RenameFinished(Ok(())));
    assert_eq!(
        update(Message::Colour(PaletteName::Moss)),
        Some(Action::SetColour(PaletteName::Moss))
    );
    assert_eq!(update(Message::Colour(PaletteName::Clay)), None);
    update(Message::ColourFinished(Err(ProfileError::Network)));
    assert_eq!(
        update(Message::Colour(PaletteName::Moss)),
        Some(Action::SetColour(PaletteName::Moss))
    );
    update(Message::ColourFinished(Ok(())));
    update(Message::Tab(Tab::Account));
    assert_eq!(
        update(Message::CopyAccountId),
        Some(Action::CopyAccountId("own".into()))
    );
    assert_eq!(update(Message::SignOut), Some(Action::SignOut));
    assert_eq!(state.name, None);
    assert!(state.colour_failed.is_none());
}

#[test]
fn shortcut_capture_reserves_fixed_keys_and_prevents_duplicates() {
    let mut state = State::default();
    let mut prefs = Preferences::default();
    let visitor = visitor();
    let audio = AudioStatus::default();
    state.open(&visitor);
    let mut update = |message| state.update(message, &mut prefs, &visitor, &audio);
    update(Message::Tab(Tab::Shortcuts));
    update(Message::Bind(Shortcut::Mute));
    assert_eq!(
        update(Message::Capture(Physical::Code(Code::Digit1))),
        Some(Action::PreferencesChanged)
    );
    update(Message::Bind(Shortcut::Mute));
    assert_eq!(
        update(Message::Capture(Physical::Code(Code::ArrowLeft))),
        None
    );
    update(Message::Bind(Shortcut::Mute));
    assert_eq!(update(Message::Capture(Physical::Code(Code::KeyD))), None);
    update(Message::Bind(Shortcut::Mute));
    assert_eq!(update(Message::Capture(Physical::Code(Code::Escape))), None);
    update(Message::Bind(Shortcut::Mute));
    assert_eq!(
        update(Message::Capture(Physical::Code(Code::KeyQ))),
        Some(Action::PreferencesChanged)
    );
    assert_eq!(prefs.shortcuts.mute.code, "KeyQ");
    assert!(!state.is_capturing_shortcut());
}

#[test]
fn share_settings_only_change_preferences_and_details_are_local_to_the_dialog() {
    let mut state = State::default();
    let mut prefs = Preferences::default();
    let visitor = visitor();
    let audio = AudioStatus {
        in_voice: true,
        ..AudioStatus::default()
    };
    state.open(&visitor);
    state.update(Message::Tab(Tab::Share), &mut prefs, &visitor, &audio);
    assert_eq!(
        state.update(Message::ShareDetails, &mut prefs, &visitor, &audio),
        None
    );
    assert_eq!(state.share_details, Some(true));
    for message in [
        Message::SharePreset(SharePreset::Docs),
        Message::ShareSound(false),
        Message::ShareBitrate(u8::MAX),
    ] {
        assert_eq!(
            state.update(message, &mut prefs, &visitor, &audio),
            Some(Action::PreferencesChanged)
        );
    }
    assert_eq!(prefs.share.preset(), Some(SharePreset::Docs));
    assert_eq!(prefs.share.bitrate_mbps, 20);
    assert!(!prefs.share.with_sound);
}
