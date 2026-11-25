mod catalog;

pub use catalog::{Key, text};

use crate::ui_contract::{EffectiveTheme, Language, LanguagePreference, ThemePreference};
use chrono::{DateTime, Datelike, Local, Utc};
use falky_core::model::PaletteName;
use iced::theme::Mode;

pub fn resolve_language(preference: LanguagePreference) -> Language {
    language_for_locale(preference, sys_locale::get_locale().as_deref())
}

fn language_for_locale(preference: LanguagePreference, locale: Option<&str>) -> Language {
    match preference {
        LanguagePreference::En => Language::En,
        LanguagePreference::Uk => Language::Uk,
        LanguagePreference::System => {
            match locale.and_then(|locale| locale.split(['-', '_', '.', '@']).next()) {
                Some(base) if base.eq_ignore_ascii_case("uk") => Language::Uk,
                _ => Language::En,
            }
        }
    }
}

pub const fn resolve_theme(preference: ThemePreference, system: Mode) -> EffectiveTheme {
    match (preference, system) {
        (ThemePreference::Light, _) | (ThemePreference::System, Mode::Light) => {
            EffectiveTheme::Light
        }
        _ => EffectiveTheme::Dark,
    }
}

pub fn palette_name(language: Language, palette: PaletteName) -> &'static str {
    text(
        language,
        match palette {
            PaletteName::Sky => Key::PaletteSky,
            PaletteName::Apricot => Key::PaletteApricot,
            PaletteName::Lagoon => Key::PaletteLagoon,
            PaletteName::Rose => Key::PaletteRose,
            PaletteName::Violet => Key::PaletteViolet,
            PaletteName::Amber => Key::PaletteAmber,
            PaletteName::Moss => Key::PaletteMoss,
            PaletteName::Coral => Key::PaletteCoral,
            PaletteName::Indigo => Key::PaletteIndigo,
            PaletteName::Plum => Key::PalettePlum,
            PaletteName::Sunset => Key::PaletteSunset,
            PaletteName::Aurora => Key::PaletteAurora,
            PaletteName::Lime => Key::PaletteLime,
            PaletteName::Clay => Key::PaletteClay,
            PaletteName::Ocean => Key::PaletteOcean,
            PaletteName::Ruby => Key::PaletteRuby,
        },
    )
}

pub fn push_to_talk(language: Language, key: &str) -> String {
    match language {
        Language::En => format!("Talk only while holding {key}"),
        Language::Uk => format!("Говорити, лише поки тримаю {}", ukrainian_key(key)),
    }
}

pub fn hold_to_talk(language: Language, key: &str) -> String {
    match language {
        Language::En => format!("Hold {key} to talk"),
        Language::Uk => format!("Тримайте {}, щоб говорити", ukrainian_key(key)),
    }
}

fn ukrainian_key(key: &str) -> &str {
    if key == "Space" { "Пробіл" } else { key }
}

pub fn minutes(language: Language, minutes: u64) -> String {
    match language {
        Language::En => format!("{minutes} min"),
        Language::Uk => format!("{minutes} хв"),
    }
}

pub fn screen_of(language: Language, name: &str) -> String {
    match language {
        Language::En => format!("{name}'s screen"),
        Language::Uk => format!("Екран {name}"),
    }
}

pub fn share_bitrate(language: Language, mbps: impl std::fmt::Display) -> String {
    match language {
        Language::En => format!("{mbps} Mbps"),
        Language::Uk => format!("{} Мбіт/с", mbps.to_string().replace('.', ",")),
    }
}

pub fn away_muted_body(language: Language, minutes: u64) -> String {
    match language {
        Language::En => format!("Nobody heard you for {minutes} minutes."),
        Language::Uk => format!("Вас не було чути {minutes} хв."),
    }
}

pub fn key_taken(language: Language, action: &str) -> String {
    match language {
        Language::En => format!("Already used: {action}"),
        Language::Uk => format!("Уже зайнята: {action}"),
    }
}

pub fn name_conflict_title(language: Language, name: &str) -> String {
    match language {
        Language::En => format!("Someone is using the name {name}"),
        Language::Uk => format!("Хтось зараз під іменем {name}"),
    }
}

pub fn account_expiry(language: Language, expiry: DateTime<Utc>) -> String {
    let local = expiry.with_timezone(&Local);
    let months = match language {
        Language::En => [
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        ],
        Language::Uk => [
            "січня",
            "лютого",
            "березня",
            "квітня",
            "травня",
            "червня",
            "липня",
            "серпня",
            "вересня",
            "жовтня",
            "листопада",
            "грудня",
        ],
    };
    let date = format!(
        "{} {} {}",
        local.day(),
        months[local.month0() as usize],
        local.year()
    );
    match language {
        Language::En => date,
        Language::Uk => format!("{date} р."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_resolves_ukrainian_and_falls_back_to_english() {
        for locale in ["uk-UA", "UK_ua.UTF-8", "uk"] {
            assert_eq!(
                language_for_locale(LanguagePreference::System, Some(locale)),
                Language::Uk
            );
        }
        for locale in [
            None,
            Some(""),
            Some("C.UTF-8"),
            Some("en-US"),
            Some("de-DE"),
            Some("ukx"),
        ] {
            assert_eq!(
                language_for_locale(LanguagePreference::System, locale),
                Language::En
            );
        }
        assert_eq!(
            language_for_locale(LanguagePreference::En, Some("uk-UA")),
            Language::En
        );
        assert_eq!(
            language_for_locale(LanguagePreference::Uk, None),
            Language::Uk
        );
        assert_eq!(text(Language::En, Key::TabSound), "Sound & notifications");
        assert_eq!(text(Language::Uk, Key::TabSound), "Звук і сповіщення");
        assert_eq!(
            push_to_talk(Language::Uk, "Space"),
            "Говорити, лише поки тримаю Пробіл"
        );
    }

    #[test]
    fn system_theme_obeys_platform_and_dark_is_default() {
        assert_eq!(
            resolve_theme(ThemePreference::System, Mode::Light),
            EffectiveTheme::Light
        );
        assert_eq!(
            resolve_theme(ThemePreference::System, Mode::None),
            EffectiveTheme::Dark
        );
        assert_eq!(
            resolve_theme(ThemePreference::Dark, Mode::Light),
            EffectiveTheme::Dark
        );
        assert_eq!(
            resolve_theme(ThemePreference::Light, Mode::Dark),
            EffectiveTheme::Light
        );
    }
}
