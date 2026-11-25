use iced::widget::{
    Column, Row, button, container, keyed_column, mouse_area, opaque, pick_list, progress_bar,
    scrollable, space, stack, text, text_input, toggler,
};
use iced::{Background, Color, Element, Fill, Shadow, Vector, alignment, border, color, gradient};
use std::fmt;

use falky_core::model::{AccountSession, PaletteName, SessionKind};
use falky_core::transport::Origin;

use crate::locale::{self, Key};
use crate::ui_contract::{
    AudioDevice, AwayMinutes, EffectiveTheme, GlobalPttStatus, Language, LanguagePreference,
    Shortcuts, ThemePreference, Viewport,
};

use super::{
    AudioStatus, BindingError, Message, Preferences, ProfileError, ShareStatus, Shortcut, State,
    Tab, VoiceFlag,
};

mod share;

pub struct Props<'a> {
    pub prefs: &'a Preferences,
    pub account: &'a AccountSession,
    pub origin: &'a Origin,
    pub audio: &'a AudioStatus,
    pub theme: EffectiveTheme,
    pub language: Language,
    pub viewport: Viewport,
    pub global_ptt: GlobalPttStatus,
    pub global_binding: Option<&'a str>,
    pub preferences_unavailable: bool,
    pub palette: fn(PaletteName, EffectiveTheme) -> [Color; 4],
}

type Content<'a> = Element<'a, Message>;

const SECTION_GAP: f32 = 22.0;
const PAD: f32 = 12.0;
const INNER_RADIUS: f32 = 16.0;
const CARD_RADIUS: f32 = INNER_RADIUS + PAD;
const DIALOG_RADIUS: f32 = CARD_RADIUS + 4.0;

pub fn view<'a>(state: &'a State, props: Props<'a>) -> Content<'a> {
    view_with_share(state, props, ShareStatus::default())
}

pub fn view_with_share<'a>(
    state: &'a State,
    props: Props<'a>,
    sharing: ShareStatus<'_>,
) -> Content<'a> {
    let Some(tab) = state.tab() else {
        return space().into();
    };
    let colors = Colors::new(props.theme);
    let narrow = props.viewport.width > 0.0 && props.viewport.width <= 760.0;
    let t = |key| locale::text(props.language, key);
    let close = control(t(Key::Close), Some(Message::Close), colors);
    let tab_button = |item| {
        let label = text(t(tab_key(item))).size(15);
        button(label)
            .width(if narrow { iced::Shrink } else { Fill })
            .padding([11, 14])
            .on_press(Message::Tab(item))
            .style(move |_, status| button_style(colors, status, tab == item, true))
    };
    let body = match tab {
        Tab::General => general(&props, colors),
        Tab::Voice => voice(&props, colors),
        Tab::Sound => sound(&props, colors),
        Tab::Share => share::view(state, &props, sharing, colors),
        Tab::Profile => profile(state, &props, colors),
        Tab::Account => account(state, &props, colors),
        Tab::Shortcuts => shortcuts(state, &props, colors),
    };
    let body = if props.preferences_unavailable {
        iced::widget::column![notice(t(Key::PreferencesUnavailable), colors), body]
            .spacing(PAD)
            .into()
    } else {
        body
    };
    let content = container(
        keyed_column([(tab, scrollable(body).width(Fill).height(Fill).into())])
            .width(Fill)
            .height(Fill),
    )
    .padding(if narrow { [14, 16] } else { [16, 26] })
    .width(Fill)
    .height(Fill);
    let title = text(t(Key::Settings)).size(22);
    let dialog: Content<'a> = if narrow {
        let tabs = Row::with_children(Tab::ALL.map(|item| tab_button(item).into())).spacing(4);
        iced::widget::column![
            bar(title, close, [14, 16]),
            container(
                scrollable(tabs)
                    .direction(scrollable::Direction::Horizontal(
                        scrollable::Scrollbar::new()
                    ))
                    .width(Fill)
            )
            .padding([0, 12]),
            content,
        ]
        .width(Fill)
        .height(Fill)
        .into()
    } else {
        let tabs = Column::with_children(Tab::ALL.map(|item| tab_button(item).into())).spacing(3);
        let navigation =
            container(iced::widget::column![container(title).padding([2, 14]), tabs].spacing(14))
                .width(224)
                .height(Fill)
                .padding([22, 12])
                .style(move |_| container::Style {
                    background: Some(colors.fill.into()),
                    border: border::rounded(
                        border::top_left(DIALOG_RADIUS).bottom_left(DIALOG_RADIUS),
                    ),
                    ..Default::default()
                });
        let header = bar(text(t(tab_key(tab))).size(18), close, [14, 22]);
        iced::widget::row![
            navigation,
            iced::widget::column![header, content]
                .width(Fill)
                .height(Fill)
        ]
        .width(Fill)
        .height(Fill)
        .into()
    };
    let surface = opaque(
        container(dialog)
            .width(Fill)
            .height(Fill)
            .max_width(960)
            .max_height(680)
            .clip(true)
            .style(move |_| container::Style {
                text_color: Some(colors.ink),
                shadow: Shadow {
                    color: colors.shadow,
                    offset: Vector::new(0.0, 20.0),
                    blur_radius: 42.0,
                },
                ..panel(colors.surface, if narrow { 0.0 } else { DIALOG_RADIUS })
            }),
    );
    let backdrop = mouse_area(
        container(space())
            .width(Fill)
            .height(Fill)
            .style(move |_| panel(colors.scrim, 0.0)),
    )
    .on_press(Message::Close);
    stack([
        backdrop.into(),
        container(surface)
            .center(Fill)
            .padding(if narrow { 0 } else { 16 })
            .into(),
    ])
    .width(Fill)
    .height(Fill)
    .into()
}

fn bar<'a>(
    left: impl Into<Content<'a>>,
    right: impl Into<Content<'a>>,
    padding: [u16; 2],
) -> Content<'a> {
    container(
        iced::widget::row![left.into(), space().width(Fill), right.into()]
            .align_y(alignment::Vertical::Center)
            .spacing(PAD),
    )
    .padding(padding)
    .width(Fill)
    .into()
}

fn general<'a>(props: &Props<'a>, colors: Colors) -> Content<'a> {
    let t = |key| locale::text(props.language, key);
    let current_theme = props.prefs.theme;
    let theme_choice = |pref, label| {
        let sample: Content<'a> = match pref {
            ThemePreference::Dark => preview(props.palette, EffectiveTheme::Dark, false),
            ThemePreference::Light => preview(props.palette, EffectiveTheme::Light, false),
            ThemePreference::System => preview(props.palette, EffectiveTheme::Dark, true),
        };
        button(
            iced::widget::column![sample, text(label).size(14)]
                .align_x(alignment::Horizontal::Center)
                .spacing(6),
        )
        .width(Fill)
        .padding(7)
        .on_press(Message::Theme(pref))
        .style(move |_, status| button_style(colors, status, pref == current_theme, false))
    };
    let themes = iced::widget::row![
        theme_choice(ThemePreference::Dark, t(Key::ThemeDark)),
        theme_choice(ThemePreference::Light, t(Key::ThemeLight)),
        theme_choice(ThemePreference::System, t(Key::ThemeSystem)),
    ]
    .width(Fill)
    .spacing(8);
    let options = [
        Choice::new(LanguagePreference::System, t(Key::LanguageSystem)),
        Choice::new(LanguagePreference::Uk, "Українська"),
        Choice::new(LanguagePreference::En, "English"),
    ];
    let language = pick_list(
        options.clone(),
        options
            .into_iter()
            .find(|choice| choice.value == props.prefs.language),
        |choice| Message::Language(choice.value),
    )
    .width(Fill)
    .padding(9)
    .text_size(15);
    section(
        t(Key::SectionLook),
        vec![
            text(t(Key::Theme)).size(15).into(),
            themes.into(),
            text(t(Key::Language)).size(15).into(),
            language.into(),
        ],
        None,
        colors,
    )
}

fn preview<'a>(
    palette: fn(PaletteName, EffectiveTheme) -> [Color; 4],
    theme: EffectiveTheme,
    split: bool,
) -> Content<'a> {
    let swatches = |theme| {
        container(
            iced::widget::row![
                swatch(palette(PaletteName::Sky, theme), 27.0),
                swatch(palette(PaletteName::Apricot, theme), 27.0)
            ]
            .spacing(5),
        )
        .center_x(Fill)
        .center_y(63)
        .style(move |_| panel(Colors::new(theme).surface, INNER_RADIUS))
    };
    if split {
        iced::widget::row![
            swatches(EffectiveTheme::Dark),
            swatches(EffectiveTheme::Light)
        ]
        .into()
    } else {
        swatches(theme).into()
    }
}

fn voice<'a>(props: &Props<'a>, colors: Colors) -> Content<'a> {
    let t = |key| locale::text(props.language, key);
    let settings = &props.prefs.voice;
    let audio = props.audio;
    let level = if audio.mic_level.is_finite() && !(audio.in_voice && audio.muted) {
        audio.mic_level.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let meter = progress_bar(0.0..=1.0, level)
        .girth(8)
        .length(Fill)
        .style(move |_| progress_bar::Style {
            background: colors.fill_strong.into(),
            bar: colors.ink.into(),
            border: border::rounded(4),
        });
    let test: Content<'a> = if audio.in_voice {
        if audio.muted {
            note(t(Key::MicMutedHint), colors)
        } else {
            space().into()
        }
    } else {
        let caption = if audio.mic_test_active {
            Key::MicTestStop
        } else {
            Key::MicTest
        };
        control(t(caption), Some(Message::MicTest), colors).into()
    };
    let mut microphone = vec![
        devices(
            t(Key::SystemDefault),
            t(Key::Mic),
            &audio.inputs,
            &settings.mic_id,
            Message::InputDevice,
            t(Key::SelectedMicUnavailable),
        ),
        text(t(Key::MicLevel)).size(14).into(),
        iced::widget::row![meter, test]
            .spacing(PAD)
            .align_y(alignment::Vertical::Center)
            .into(),
    ];
    if audio.input_unavailable {
        microphone.push(notice(t(Key::VoiceMicMissing), colors));
    }
    let process = [
        (
            Key::NoiseSuppression,
            VoiceFlag::NoiseSuppression,
            settings.noise_suppression,
        ),
        (
            Key::EchoCancellation,
            VoiceFlag::EchoCancellation,
            settings.echo_cancellation,
        ),
        (Key::AutoGain, VoiceFlag::AutoGain, settings.auto_gain),
    ]
    .into_iter()
    .map(|(label, flag, on)| toggle(t(label), on, move |on| Message::VoiceFlag(flag, on)))
    .collect();
    let mut behaviour = vec![
        toggle(
            locale::push_to_talk(props.language, &props.prefs.shortcuts.push_to_talk.label),
            settings.push_to_talk,
            |on| Message::VoiceFlag(VoiceFlag::PushToTalk, on),
        ),
        toggle(t(Key::JoinMuted), settings.join_muted, |on| {
            Message::VoiceFlag(VoiceFlag::JoinMuted, on)
        }),
        toggle(t(Key::AwayMute), settings.away_mute, |on| {
            Message::VoiceFlag(VoiceFlag::AwayMute, on)
        }),
    ];
    if settings.away_mute {
        let options = [AwayMinutes::Five, AwayMinutes::Ten, AwayMinutes::Thirty];
        let current_minutes = settings.away_minutes;
        let choices = Row::with_children(options.map(|minutes| {
            let label = locale::minutes(props.language, minutes.duration().as_secs() / 60);
            button(text(label).size(14))
                .on_press(Message::AwayMinutes(minutes))
                .padding([5, 11])
                .style(move |_, status| {
                    button_style(colors, status, minutes == current_minutes, false)
                })
                .into()
        }))
        .spacing(6);
        behaviour.push(
            iced::widget::row![text(t(Key::AwayAfter)).size(14), choices]
                .spacing(PAD)
                .align_y(alignment::Vertical::Center)
                .into(),
        );
    }
    iced::widget::column![
        section(t(Key::Mic), microphone, None, colors),
        section(
            t(Key::GroupProcessing),
            process,
            Some(t(Key::ProcessingNote)),
            colors
        ),
        section(t(Key::GroupBehaviour), behaviour, None, colors),
    ]
    .spacing(SECTION_GAP)
    .into()
}

fn sound<'a>(props: &Props<'a>, colors: Colors) -> Content<'a> {
    let t = |key| locale::text(props.language, key);
    let mut speaker = vec![
        iced::widget::row![
            devices(
                t(Key::SystemDefault),
                t(Key::Speakers),
                &props.audio.outputs,
                &props.prefs.voice.speaker_id,
                Message::OutputDevice,
                t(Key::SelectedSpeakerUnavailable),
            ),
            control(
                t(Key::TestSound),
                (!props.audio.speaker_test_active).then_some(Message::SpeakerTest),
                colors
            ),
        ]
        .spacing(8)
        .align_y(alignment::Vertical::Center)
        .into(),
    ];
    if props.audio.output_unavailable {
        speaker.push(notice(t(Key::SpeakerUnavailable), colors));
    }
    iced::widget::column![
        section(t(Key::Speakers), speaker, None, colors),
        section(
            t(Key::GroupSounds),
            vec![toggle(
                t(Key::EventSounds),
                props.prefs.chimes,
                Message::Chimes
            )],
            None,
            colors
        ),
        section(
            t(Key::SectionAlerts),
            vec![toggle(
                t(Key::Notifications),
                props.prefs.notifications,
                Message::Notifications
            )],
            None,
            colors
        ),
    ]
    .spacing(SECTION_GAP)
    .into()
}

fn profile<'a>(state: &'a State, props: &Props<'a>, colors: Colors) -> Content<'a> {
    let visitor = &props.account.visitor;
    let name = state.name.as_deref().unwrap_or(&visitor.name);
    let t = |key| locale::text(props.language, key);
    let confirmed = visitor.colour.palette;
    let selected = state.colour_pending.unwrap_or(confirmed);
    let mut edit = text_input(t(Key::Name), name).padding(8).size(15);
    let can_submit = !name.trim().is_empty() && name.trim() != visitor.name && !state.name_pending;
    if !state.name_pending {
        edit = edit.on_input(Message::NameEdited);
    }
    if can_submit {
        edit = edit.on_submit(Message::SaveName);
    }
    let mut name_rows = vec![
        iced::widget::row![
            edit,
            control(
                t(Key::Save),
                can_submit.then_some(Message::SaveName),
                colors
            )
        ]
        .spacing(8)
        .into(),
    ];
    if visitor.name_taken {
        name_rows.push(note(t(Key::NameConflictBody), colors));
    }
    if let Some(error) = state.name_error {
        let key = match error {
            ProfileError::InvalidName => Key::ErrorInvalidName,
            ProfileError::NameTaken => Key::ErrorNameTaken,
            ProfileError::Network => Key::ErrorNetwork,
            ProfileError::Other => Key::ErrorOther,
        };
        name_rows.push(notice(t(key), colors));
    }

    let mut shades = Column::new().spacing(4);
    let columns = if props.viewport.width > 0.0 && props.viewport.width < 450.0 {
        3
    } else {
        4
    };
    for group in PaletteName::ALL.chunks(columns) {
        let choices = Row::with_children(group.iter().map(|&palette| {
            let label = locale::palette_name(props.language, palette);
            let avatar = swatch((props.palette)(palette, props.theme), 37.0);
            let content = iced::widget::column![avatar, text(label).size(13)]
                .spacing(4)
                .width(Fill)
                .align_x(alignment::Horizontal::Center);
            button(content)
                .width(Fill)
                .padding([6, 3])
                .on_press_maybe(
                    state
                        .colour_pending
                        .is_none()
                        .then_some(Message::Colour(palette)),
                )
                .style(move |_, status| button_style(colors, status, palette == selected, true))
                .into()
        }))
        .spacing(4)
        .width(Fill);
        shades = shades.push(choices);
    }
    let mut colour_rows = vec![shades.into()];
    if state.colour_pending.is_some() {
        colour_rows.push(note(t(Key::ColourSaving), colors));
    }
    if let Some(failed) = state.colour_failed {
        colour_rows.push(notice(t(Key::ColourSaveFailed), colors));
        colour_rows.push(control(t(Key::Retry), Some(Message::Colour(failed)), colors).into());
    }
    let display_name = if name.trim().is_empty() {
        &visitor.name
    } else {
        name.trim()
    };
    let avatar = iced::widget::row![
        swatch((props.palette)(selected, props.theme), 60.0),
        text(display_name).size(19)
    ]
    .align_y(alignment::Vertical::Center)
    .spacing(14);
    iced::widget::column![
        avatar,
        section(t(Key::Name), name_rows, None, colors),
        section(
            t(Key::VisitorColour),
            colour_rows,
            Some(t(Key::VisitorColourHint)),
            colors
        ),
    ]
    .padding([0, 2])
    .spacing(SECTION_GAP)
    .into()
}

fn account<'a>(state: &'a State, props: &Props<'a>, colors: Colors) -> Content<'a> {
    let t = |key| locale::text(props.language, key);
    let visitor = &props.account.visitor;
    let account = props.account.kind == SessionKind::Account;
    let kind = if account {
        Key::AccountKindAccount
    } else {
        Key::AccountKindGuest
    };
    let mut details = vec![
        iced::widget::row![
            swatch((props.palette)(visitor.colour.palette, props.theme), 54.0),
            iced::widget::column![text(&visitor.name).size(18), note(t(kind), colors)].spacing(3),
        ]
        .spacing(PAD)
        .align_y(alignment::Vertical::Center)
        .into(),
    ];
    if account {
        let copy_label = if state.copied_id {
            Key::AccountIdCopied
        } else {
            Key::AccountCopyId
        };
        details.push(
            iced::widget::row![
                iced::widget::column![
                    text(t(Key::AccountId)).size(14),
                    note(visitor.id.as_str(), colors)
                ]
                .spacing(4)
                .width(Fill),
                control(t(copy_label), Some(Message::CopyAccountId), colors),
            ]
            .spacing(8)
            .align_y(alignment::Vertical::Center)
            .into(),
        );
    }
    if let Some(expiry) = props.account.expires_at {
        details.push(labeled_value(
            t(Key::AccountExpires),
            locale::account_expiry(props.language, expiry),
            colors,
        ));
    }
    details.push(labeled_value(t(Key::Server), props.origin.as_str(), colors));
    let logout = button(text(t(Key::AccountSignOut)).size(15))
        .padding([9, 16])
        .on_press(Message::SignOut)
        .style(move |_, status| {
            let mut style = button_style(colors, status, false, false);
            style.text_color = colors.danger;
            style
        });
    iced::widget::column![section(t(Key::AccountYou), details, None, colors), logout]
        .spacing(SECTION_GAP)
        .into()
}

fn shortcuts<'a>(state: &'a State, props: &Props<'a>, colors: Colors) -> Content<'a> {
    let t = |key| locale::text(props.language, key);
    let mut in_voice = Vec::new();
    for shortcut in Shortcut::ALL {
        if shortcut == Shortcut::PushToTalk && !props.prefs.voice.push_to_talk {
            continue;
        }
        let key = shortcut.binding(&props.prefs.shortcuts);
        let capturing = state.capturing == Some(shortcut);
        let caption = if capturing {
            t(Key::KeyPress)
        } else {
            &key.label
        };
        let mut change =
            iced::widget::row![control(caption, Some(Message::Bind(shortcut)), colors)].spacing(6);
        if key.code != shortcut.binding(&Shortcuts::default()).code {
            change = change.push(control(
                t(Key::KeyReset),
                Some(Message::Reset(shortcut)),
                colors,
            ));
        }
        in_voice.push(labeled_row(t(shortcut_key(shortcut)), change));
        if let Some((_, error)) = state
            .binding_error
            .filter(|(target, _)| *target == shortcut)
        {
            let error = match error {
                BindingError::Reserved => t(Key::KeyReserved).to_owned(),
                BindingError::Taken(other) => {
                    locale::key_taken(props.language, t(shortcut_key(other)))
                }
            };
            in_voice.push(notice(error, colors));
        }
    }
    if props.prefs.voice.push_to_talk {
        if let Some(binding) = props
            .global_binding
            .filter(|_| props.global_ptt == GlobalPttStatus::Available)
        {
            in_voice.push(labeled_value(t(Key::GlobalPtt), binding, colors));
        }
        if props.global_ptt == GlobalPttStatus::AccessibilityRequired {
            in_voice.push(note(t(Key::GlobalPttAccessibility), colors));
            in_voice.push(
                control(
                    t(Key::OpenAccessibilitySettings),
                    Some(Message::OpenAccessibilitySettings),
                    colors,
                )
                .into(),
            );
        }
        if matches!(
            props.global_ptt,
            GlobalPttStatus::Unavailable | GlobalPttStatus::AccessibilityRequired
        ) {
            in_voice.push(note(t(Key::GlobalPttUnavailable), colors));
        }
    }
    let anywhere = vec![
        labeled_value(
            t(Key::KeyChat),
            format!("/ {} Enter", t(Key::KeyOr)),
            colors,
        ),
        labeled_value(t(Key::KeyRooms), "←   →", colors),
        labeled_value(t(Key::KeyClose), "Esc", colors),
    ];
    iced::widget::column![
        section(
            t(Key::KeysInVoice),
            in_voice,
            Some(t(Key::KeysHint)),
            colors
        ),
        section(t(Key::KeysAnywhere), anywhere, None, colors),
    ]
    .spacing(SECTION_GAP)
    .into()
}

fn tab_key(tab: Tab) -> Key {
    match tab {
        Tab::General => Key::TabGeneral,
        Tab::Voice => Key::SectionVoice,
        Tab::Sound => Key::TabSound,
        Tab::Share => Key::TabShare,
        Tab::Profile => Key::SectionProfile,
        Tab::Account => Key::Account,
        Tab::Shortcuts => Key::TabKeys,
    }
}

fn shortcut_key(shortcut: Shortcut) -> Key {
    match shortcut {
        Shortcut::Mute => Key::KeyMute,
        Shortcut::Deafen => Key::KeyDeafen,
        Shortcut::PushToTalk => Key::KeyPushToTalk,
        Shortcut::Leave => Key::KeyLeave,
    }
}

#[derive(Clone, Debug)]
struct Choice<V> {
    value: V,
    label: String,
}

impl<V> Choice<V> {
    fn new(value: V, label: impl Into<String>) -> Self {
        Self {
            value,
            label: label.into(),
        }
    }
}

impl<V: PartialEq> PartialEq for Choice<V> {
    fn eq(&self, other: &Self) -> bool {
        self.value == other.value
    }
}

impl<V> fmt::Display for Choice<V> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label)
    }
}

fn devices<'a>(
    default_label: &str,
    kind: &str,
    devices: &[AudioDevice],
    selected: &str,
    apply: fn(String) -> Message,
    unavailable: &str,
) -> Content<'a> {
    let mut options = vec![Choice::new(String::new(), default_label)];
    for device in devices {
        if device.id.is_empty() || options.iter().any(|choice| choice.value == device.id) {
            continue;
        }
        let label = if device.name.is_empty() {
            format!("{kind} {}", options.len())
        } else {
            device.name.clone()
        };
        options.push(Choice::new(device.id.clone(), label));
    }
    let selected = options
        .iter()
        .find(|choice| choice.value == selected)
        .cloned();
    pick_list(options, selected, move |choice| apply(choice.value))
        .placeholder(unavailable)
        .width(Fill)
        .padding(9)
        .text_size(15)
        .into()
}

fn toggle<'a>(
    label: impl text::IntoFragment<'a>,
    on: bool,
    action: impl Fn(bool) -> Message + 'a,
) -> Content<'a> {
    toggler(on)
        .label(label)
        .text_size(15)
        .spacing(PAD)
        .size(18)
        .width(Fill)
        .on_toggle(action)
        .into()
}

fn section<'a>(
    heading: &'a str,
    rows: Vec<Content<'a>>,
    explanation: Option<&'a str>,
    colors: Colors,
) -> Content<'a> {
    let surface = container(Column::with_children(rows).spacing(PAD).width(Fill))
        .width(Fill)
        .padding(PAD)
        .style(move |_| panel(colors.fill, CARD_RADIUS));
    let mut group =
        iced::widget::column![container(text(heading).size(15)).padding([0, 10]), surface]
            .spacing(7)
            .width(Fill);
    if let Some(explanation) = explanation {
        group = group.push(container(note(explanation, colors)).padding([0, 10]));
    }
    group.into()
}

fn control<'a>(
    label: impl text::IntoFragment<'a>,
    action: Option<Message>,
    colors: Colors,
) -> button::Button<'a, Message> {
    button(text(label).size(14))
        .padding([7, 12])
        .on_press_maybe(action)
        .style(move |_, status| button_style(colors, status, false, false))
}

fn labeled_value<'a>(
    label: &'a str,
    value: impl text::IntoFragment<'a>,
    colors: Colors,
) -> Content<'a> {
    labeled_row(label, note(value, colors))
}

fn labeled_row<'a>(label: &'a str, value: impl Into<Content<'a>>) -> Content<'a> {
    iced::widget::row![text(label).size(15).width(Fill), value.into()]
        .spacing(PAD)
        .align_y(alignment::Vertical::Center)
        .width(Fill)
        .into()
}

fn note<'a>(label: impl text::IntoFragment<'a>, colors: Colors) -> Content<'a> {
    text(label).size(13).color(colors.muted).into()
}

fn notice<'a>(label: impl text::IntoFragment<'a>, colors: Colors) -> Content<'a> {
    text(label).size(13).color(colors.danger).into()
}

fn swatch<'a>([base, bright, deep, core]: [Color; 4], size: f32) -> Content<'a> {
    let gradient = gradient::Linear::new(2.2)
        .add_stop(0.0, bright)
        .add_stop(0.32, core)
        .add_stop(0.63, base)
        .add_stop(1.0, deep);
    container(space())
        .width(size)
        .height(size)
        .style(move |_| panel(gradient, size * 0.34))
        .into()
}

fn panel(background: impl Into<Background>, radius: f32) -> container::Style {
    container::Style {
        background: Some(background.into()),
        border: border::rounded(radius),
        ..Default::default()
    }
}

fn button_style(
    colors: Colors,
    status: button::Status,
    selected: bool,
    transparent_at_rest: bool,
) -> button::Style {
    let (fill, ink) = if selected {
        (colors.ink, colors.surface)
    } else {
        let fill = match status {
            button::Status::Hovered | button::Status::Pressed => colors.fill_hover,
            button::Status::Active | button::Status::Disabled if transparent_at_rest => {
                Color::TRANSPARENT
            }
            _ => colors.fill_strong,
        };
        (fill, colors.ink)
    };
    button::Style {
        background: Some(fill.into()),
        text_color: if status == button::Status::Disabled && !selected {
            colors.muted
        } else {
            ink
        },
        border: border::rounded(INNER_RADIUS),
        ..Default::default()
    }
}

#[derive(Clone, Copy)]
struct Colors {
    surface: Color,
    ink: Color,
    muted: Color,
    fill: Color,
    fill_strong: Color,
    fill_hover: Color,
    scrim: Color,
    shadow: Color,
    danger: Color,
}

impl Colors {
    fn new(theme: EffectiveTheme) -> Self {
        match theme {
            EffectiveTheme::Dark => Self {
                surface: color!(0x232320),
                ink: Color::WHITE,
                muted: color!(0xb7b7b6),
                fill: color!(0x373734),
                fill_strong: color!(0x4e4e4b),
                fill_hover: color!(0x5d5d5a),
                scrim: Color::BLACK.scale_alpha(0.55),
                shadow: Color::BLACK.scale_alpha(0.6),
                danger: color!(0xfd8d78),
            },
            EffectiveTheme::Light => Self {
                surface: Color::WHITE,
                ink: color!(0x111111),
                muted: color!(0x616161),
                fill: color!(0xf0f0f0),
                fill_strong: color!(0xe0e0e0),
                fill_hover: color!(0xd3d3d3),
                scrim: Color::BLACK.scale_alpha(0.32),
                shadow: Color::BLACK.scale_alpha(0.14),
                danger: color!(0xc93030),
            },
        }
    }
}
