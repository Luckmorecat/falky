use iced::Fill;
use iced::widget::{Row, button, column, container, pick_list, slider, text, toggler};

use crate::locale::{self, Key};

use super::super::share::{BITRATE_PRESETS_MBPS, MAX_BITRATE_MBPS};
use super::super::{
    ShareAudioAvailability, ShareCodec, ShareFocus, ShareFps, SharePreset, ShareResolution,
};
use super::{
    CARD_RADIUS, Choice, Colors, Content, Message, PAD, Props, SECTION_GAP, ShareStatus, State,
    button_style, labeled_row, note, panel, section,
};

pub(super) fn view<'a>(
    state: &State,
    props: &Props<'_>,
    status: ShareStatus<'_>,
    colors: Colors,
) -> Content<'a> {
    let language = props.language;
    let t = |key| locale::text(language, key);
    let settings = props.prefs.share;
    let current = settings.preset();
    let preset_buttons = buttons(
        SharePreset::ALL.map(|preset| (preset, t(preset_key(preset)).to_owned())),
        current,
        Message::SharePreset,
        colors,
    );
    let can_share_sound = status.capture_available && status.audio.supports_sound();
    let sound = toggler(settings.with_sound && can_share_sound)
        .label(t(Key::ShareWithSound))
        .text_size(15)
        .spacing(PAD)
        .size(18)
        .width(Fill)
        .on_toggle_maybe(can_share_sound.then_some(Message::ShareSound));
    let mut rows = vec![preset_buttons, sound.into()];
    if let Some(key) = audio_note(status.audio) {
        rows.push(note(t(key), colors));
    }
    if !status.capture_available {
        rows.push(note(t(Key::ShareCaptureUnavailable), colors));
    }
    let preset_hint = if status.sharing {
        Some(t(Key::ShareNextTime))
    } else {
        current.map(|preset| t(preset_hint(preset)))
    };
    let basics = section(t(Key::SharePreset), rows, preset_hint, colors);

    let expanded = state.share_details.unwrap_or(current.is_none());
    let details = button(labeled_row(
        t(Key::ShareDetails),
        crate::shell::icon::icon(
            if expanded {
                crate::shell::icon::Icon::Collapse
            } else {
                crate::shell::icon::Icon::Down
            },
            16.0,
            colors.ink,
        ),
    ))
    .on_press(Message::ShareDetails)
    .width(Fill)
    .padding(PAD)
    .style(move |_, status| button_style(colors, status, false, true));

    let mut body = column![basics, details].spacing(if expanded { PAD } else { SECTION_GAP });
    if expanded {
        let resolution = buttons(
            ShareResolution::ALL.map(|value| (value, format!("{}p", value.height()))),
            Some(settings.resolution),
            Message::ShareResolution,
            colors,
        );
        let fps = buttons(
            ShareFps::ALL.map(|value| (value, value.value().to_string())),
            Some(settings.fps),
            Message::ShareFps,
            colors,
        );
        let focus = buttons(
            [
                (ShareFocus::Motion, t(Key::ShareMotion).to_owned()),
                (ShareFocus::Detail, t(Key::ShareDetail).to_owned()),
            ],
            Some(settings.focus),
            Message::ShareFocus,
            colors,
        );
        let resolved = settings.resolved_codec(status.codecs);
        let codec = pick_list(
            status
                .codecs
                .iter()
                .copied()
                .map(codec_choice)
                .collect::<Vec<_>>(),
            Some(codec_choice(resolved)),
            |choice| Message::ShareCodec(choice.value),
        )
        .padding(9)
        .text_size(15);
        let current_mbps = settings.bitrate_mbps.min(MAX_BITRATE_MBPS);
        let bitrate = buttons(
            BITRATE_PRESETS_MBPS.map(|value| {
                (
                    value,
                    if value == 0 {
                        t(Key::ShareBitrateAuto).to_owned()
                    } else {
                        locale::share_bitrate(language, value)
                    },
                )
            }),
            Some(current_mbps),
            Message::ShareBitrate,
            colors,
        );
        let value = if current_mbps == 0 {
            let mbps = (settings.bitrate_bps() as f32 / 100_000.0).round() / 10.0;
            format!(
                "{} · {}",
                t(Key::ShareBitrateAuto),
                locale::share_bitrate(language, mbps)
            )
        } else {
            locale::share_bitrate(language, current_mbps)
        };
        let focus_hint = match settings.focus {
            ShareFocus::Motion => Key::ShareMotionHint,
            ShareFocus::Detail => Key::ShareDetailHint,
        };
        body = body.push(
            container(
                column![
                    labeled_row(t(Key::ShareResolution), resolution),
                    labeled_row(t(Key::ShareFps), fps),
                    labeled_row(t(Key::ShareFocus), focus),
                    note(t(focus_hint), colors),
                    labeled_row(t(Key::ShareCodec), codec),
                    labeled_row(t(Key::ShareBitrate), note(value, colors)),
                    bitrate,
                    slider(0..=MAX_BITRATE_MBPS, current_mbps, Message::ShareBitrate).height(24),
                ]
                .spacing(PAD),
            )
            .padding(PAD)
            .width(Fill)
            .style(move |_| panel(colors.fill, CARD_RADIUS)),
        );
    }
    body.width(Fill).into()
}

fn buttons<'a, V: Copy + Eq>(
    options: impl IntoIterator<Item = (V, String)>,
    selected: Option<V>,
    message: impl Fn(V) -> Message,
    colors: Colors,
) -> Content<'a> {
    Row::with_children(options.into_iter().map(|(value, name)| {
        let active = selected == Some(value);
        button(text(name).size(14))
            .padding([7, 10])
            .on_press(message(value))
            .style(move |_, status| button_style(colors, status, active, false))
            .into()
    }))
    .spacing(4)
    .wrap()
    .into()
}

fn codec_choice(codec: ShareCodec) -> Choice<ShareCodec> {
    Choice::new(codec, codec.label())
}

fn preset_key(preset: SharePreset) -> Key {
    match preset {
        SharePreset::Docs => Key::ShareDocs,
        SharePreset::Games => Key::ShareGames,
        SharePreset::Video => Key::ShareVideo,
    }
}

fn preset_hint(preset: SharePreset) -> Key {
    match preset {
        SharePreset::Docs => Key::ShareDocsHint,
        SharePreset::Games => Key::ShareGamesHint,
        SharePreset::Video => Key::ShareVideoHint,
    }
}

fn audio_note(availability: ShareAudioAvailability) -> Option<Key> {
    Some(match availability {
        ShareAudioAvailability::Available => return None,
        ShareAudioAvailability::WindowsSystemAudio => Key::ShareAudioWindowsScope,
        ShareAudioAvailability::LinuxUnavailable => Key::ShareAudioLinux,
        ShareAudioAvailability::MacosUnavailable => Key::ShareAudioMacos,
        ShareAudioAvailability::WindowsUnavailable => Key::ShareAudioWindows,
        ShareAudioAvailability::Unavailable => Key::ShareAudioUnavailable,
    })
}
