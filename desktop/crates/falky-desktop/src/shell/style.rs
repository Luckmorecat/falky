use std::sync::OnceLock;

use crate::ui_contract::EffectiveTheme;
use falky_core::model::PaletteName;
use iced::{Color, Theme, theme};

#[derive(Clone, Copy, Debug)]
pub struct Colors {
    pub background: Color,
    pub surface: Color,
    pub raised: Color,
    pub raised_hover: Color,
    pub fill: Color,
    pub fill_strong: Color,
    pub text: Color,
    pub secondary: Color,
    pub muted: Color,
    pub invert: Color,
    pub on_invert: Color,
    pub danger: Color,
    pub danger_background: Color,
    pub dot: Color,
    pub shadow: Color,
}

impl Colors {
    pub fn new(theme: EffectiveTheme) -> Self {
        let light = theme == EffectiveTheme::Light;
        let neutral = |l| {
            if light {
                Oklch(l, 0.0, 0.0)
            } else {
                Oklch(l, 0.002, 106.6)
            }
            .srgb()
        };
        let wash = if light { Color::BLACK } else { Color::WHITE };
        let text = if light { neutral(0.178) } else { Color::WHITE };

        Self {
            background: if light { Color::WHITE } else { neutral(0.2) },
            surface: if light { Color::WHITE } else { neutral(0.256) },
            raised: neutral(if light { 0.961 } else { 0.285 }),
            raised_hover: neutral(if light { 0.925 } else { 0.371 }),
            fill: alpha(wash, if light { 0.06 } else { 0.09 }),
            fill_strong: alpha(wash, if light { 0.12 } else { 0.17 }),
            text,
            secondary: alpha(wash, 0.62),
            muted: alpha(wash, if light { 0.56 } else { 0.48 }),
            invert: text,
            on_invert: if light { Color::WHITE } else { Color::BLACK },
            danger: if light {
                Oklch(0.566, 0.194, 28.1)
            } else {
                Oklch(0.755, 0.151, 37.9)
            }
            .srgb(),
            danger_background: if light {
                Oklch(0.956, 0.019, 21.6)
            } else {
                Oklch(0.254, 0.059, 31.2)
            }
            .srgb(),
            dot: alpha(wash, if light { 0.12 } else { 0.07 }),
            shadow: alpha(Color::BLACK, if light { 0.14 } else { 0.6 }),
        }
    }
}

pub fn theme(selected: EffectiveTheme) -> Theme {
    let colors = Colors::new(selected);
    let name = match selected {
        EffectiveTheme::Light => "Falky Light",
        EffectiveTheme::Dark => "Falky Dark",
    };
    Theme::custom(
        name,
        theme::Palette {
            background: colors.background,
            text: colors.text,
            primary: colors.invert,
            success: colors.text,
            warning: colors.text,
            danger: colors.danger,
        },
    )
}

pub(super) fn alpha(color: Color, opacity: f32) -> Color {
    Color {
        a: color.a * opacity,
        ..color
    }
}

/// The four FBM stops, in body, cloud, shadow and cloud-heart order.
pub fn palette(name: PaletteName, theme: EffectiveTheme) -> [Color; 4] {
    *palette_colors(name, theme)
        .orb
        .get_or_init(|| stops(name, theme).map(Oklch::srgb))
}

/// High-contrast web name tint for an identity on this theme.
pub fn identity_name(name: PaletteName, theme: EffectiveTheme) -> Color {
    *palette_colors(name, theme).name.get_or_init(|| {
        let Oklch(_, c, h) = stops(name, theme)[0];
        match theme {
            EffectiveTheme::Dark => Oklch(0.82, c.clamp(0.05, 0.14), h),
            EffectiveTheme::Light => Oklch(0.47, c.clamp(0.07, 0.17), h),
        }
        .srgb()
    })
}

pub fn identity_wash(name: PaletteName, theme: EffectiveTheme) -> Color {
    *palette_colors(name, theme).wash.get_or_init(|| {
        let base = stops(name, theme)[0];
        match theme {
            EffectiveTheme::Dark => alpha(base.srgb(), 0.16),
            EffectiveTheme::Light => Oklch(0.95, base.1 * 0.35, base.2).srgb(),
        }
    })
}

struct PaletteColors {
    orb: OnceLock<[Color; 4]>,
    name: OnceLock<Color>,
    wash: OnceLock<Color>,
}

impl PaletteColors {
    const fn new() -> Self {
        Self {
            orb: OnceLock::new(),
            name: OnceLock::new(),
            wash: OnceLock::new(),
        }
    }
}

fn palette_colors(name: PaletteName, theme: EffectiveTheme) -> &'static PaletteColors {
    const COUNT: usize = PaletteName::ALL.len();
    static DARK: [PaletteColors; COUNT] = [const { PaletteColors::new() }; COUNT];
    static LIGHT: [PaletteColors; COUNT] = [const { PaletteColors::new() }; COUNT];

    let palettes = match theme {
        EffectiveTheme::Dark => &DARK,
        EffectiveTheme::Light => &LIGHT,
    };
    &palettes[name as usize]
}

pub fn room_palette(index: usize) -> PaletteName {
    PaletteName::ALL[index % PaletteName::ALL.len()]
}

pub(super) fn hash_string(value: &str) -> u32 {
    value.encode_utf16().fold(2_166_136_261, |hash, ch| {
        (hash ^ u32::from(ch)).wrapping_mul(16_777_619)
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Oklch(f64, f64, f64);

impl Oklch {
    fn srgb(self) -> Color {
        let Self(lightness, chroma, hue) = self;
        let (sin, cos) = hue.to_radians().sin_cos();
        let a = chroma * cos;
        let b = chroma * sin;
        let l = (lightness + 0.3963377774 * a + 0.2158037573 * b).powi(3);
        let m = (lightness - 0.1055613458 * a - 0.0638541728 * b).powi(3);
        let s = (lightness - 0.0894841775 * a - 1.2914855480 * b).powi(3);
        let encode = |value: f64| {
            let srgb = if value <= 0.0031308 {
                12.92 * value
            } else {
                1.055 * value.powf(1.0 / 2.4) - 0.055
            };
            srgb.clamp(0.0, 1.0) as f32
        };
        Color::from_rgb(
            encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
            encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
            encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
        )
    }

    fn shifted(self, lightness: f64, chroma: f64) -> Self {
        let rounded = |value: f64| (value * 1000.0).round() / 1000.0;
        Self(rounded(lightness), rounded(chroma.min(0.26)), self.2)
    }
}

fn stops(name: PaletteName, theme: EffectiveTheme) -> [Oklch; 4] {
    let colors = match name {
        PaletteName::Sky => [
            Oklch(0.672, 0.148, 254.0),
            Oklch(0.853, 0.068, 237.2),
            Oklch(0.606, 0.171, 258.5),
            Oklch(0.981, 0.009, 171.8),
        ],
        PaletteName::Apricot => [
            Oklch(0.725, 0.058, 292.9),
            Oklch(0.762, 0.152, 60.9),
            Oklch(0.646, 0.074, 292.4),
            Oklch(0.918, 0.026, 305.8),
        ],
        PaletteName::Lagoon => [
            Oklch(0.778, 0.139, 172.2),
            Oklch(0.873, 0.104, 174.0),
            Oklch(0.523, 0.088, 184.6),
            Oklch(0.811, 0.204, 146.9),
        ],
        PaletteName::Rose => [
            Oklch(0.754, 0.125, 2.5),
            Oklch(0.882, 0.062, 24.5),
            Oklch(0.592, 0.172, 357.6),
            Oklch(0.966, 0.021, 60.8),
        ],
        PaletteName::Violet => [
            Oklch(0.613, 0.191, 284.4),
            Oklch(0.776, 0.123, 290.6),
            Oklch(0.46, 0.211, 279.8),
            Oklch(0.851, 0.097, 326.4),
        ],
        PaletteName::Amber => [
            Oklch(0.808, 0.145, 79.1),
            Oklch(0.914, 0.111, 90.3),
            Oklch(0.681, 0.16, 50.5),
            Oklch(0.975, 0.036, 93.3),
        ],
        PaletteName::Moss => [
            Oklch(0.774, 0.144, 126.8),
            Oklch(0.913, 0.099, 118.1),
            Oklch(0.577, 0.113, 142.3),
            Oklch(0.985, 0.051, 115.6),
        ],
        PaletteName::Coral => [
            Oklch(0.681, 0.174, 33.3),
            Oklch(0.813, 0.116, 49.2),
            Oklch(0.53, 0.174, 7.1),
            Oklch(0.931, 0.051, 70.0),
        ],
        PaletteName::Indigo => [
            Oklch(0.543, 0.198, 271.5),
            Oklch(0.74, 0.134, 272.9),
            Oklch(0.368, 0.155, 271.6),
            Oklch(0.899, 0.049, 275.2),
        ],
        PaletteName::Plum => [
            Oklch(0.564, 0.168, 328.3),
            Oklch(0.748, 0.144, 330.3),
            Oklch(0.373, 0.129, 321.7),
            Oklch(0.908, 0.068, 336.2),
        ],
        PaletteName::Sunset => [
            Oklch(0.685, 0.184, 4.8),
            Oklch(0.823, 0.136, 67.6),
            Oklch(0.533, 0.185, 351.9),
            Oklch(0.937, 0.086, 91.6),
        ],
        PaletteName::Aurora => [
            Oklch(0.717, 0.113, 208.4),
            Oklch(0.726, 0.166, 298.7),
            Oklch(0.515, 0.104, 237.9),
            Oklch(0.968, 0.045, 170.1),
        ],
        PaletteName::Lime => [
            Oklch(0.865, 0.189, 119.4),
            Oklch(0.966, 0.142, 114.3),
            Oklch(0.669, 0.162, 126.9),
            Oklch(0.988, 0.053, 109.6),
        ],
        PaletteName::Clay => [
            Oklch(0.634, 0.092, 45.4),
            Oklch(0.815, 0.073, 56.2),
            Oklch(0.455, 0.083, 42.2),
            Oklch(0.927, 0.034, 65.9),
        ],
        PaletteName::Ocean => [
            Oklch(0.602, 0.1, 217.3),
            Oklch(0.81, 0.094, 203.2),
            Oklch(0.44, 0.083, 231.3),
            Oklch(0.964, 0.037, 205.0),
        ],
        PaletteName::Ruby => [
            Oklch(0.572, 0.203, 12.9),
            Oklch(0.737, 0.162, 16.3),
            Oklch(0.393, 0.143, 7.2),
            Oklch(0.887, 0.06, 31.1),
        ],
    };
    if theme == EffectiveTheme::Dark {
        return colors;
    }

    let [base, bright, deep, core] = colors;
    let heart_chroma = if core.1 < 0.08 {
        (core.1 * 1.6).max(0.045)
    } else {
        core.1
    };
    [
        base.shifted(base.0 * 0.9 + 0.02, base.1 * 1.15),
        bright.shifted((bright.0 * 0.9 + 0.02).min(0.86), bright.1 * 1.2),
        deep.shifted(deep.0 * 0.9, deep.1 * 1.1),
        core.shifted(core.0.min(0.92), heart_chroma),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn cached_palettes_match_each_uncached_role_across_theme_switches() {
        let bits = |color: Color| [color.r, color.g, color.b, color.a].map(f32::to_bits);
        for theme in [
            EffectiveTheme::Dark,
            EffectiveTheme::Light,
            EffectiveTheme::Dark,
        ] {
            for name in PaletteName::ALL {
                let reference = stops(name, theme);
                let Oklch(_, c, h) = reference[0];
                let name_color = match theme {
                    EffectiveTheme::Dark => Oklch(0.82, c.clamp(0.05, 0.14), h),
                    EffectiveTheme::Light => Oklch(0.47, c.clamp(0.07, 0.17), h),
                }
                .srgb();
                let wash = match theme {
                    EffectiveTheme::Dark => alpha(reference[0].srgb(), 0.16),
                    EffectiveTheme::Light => Oklch(0.95, c * 0.35, h).srgb(),
                };
                assert_eq!(
                    palette(name, theme).map(bits),
                    reference.map(Oklch::srgb).map(bits)
                );
                assert_eq!(bits(identity_name(name, theme)), bits(name_color));
                assert_eq!(bits(identity_wash(name, theme)), bits(wash));
            }
        }
    }

    #[test]
    fn room_palette_cycles_in_web_order() {
        assert_eq!(
            PaletteName::ALL.map(|name| name),
            std::array::from_fn(room_palette)
        );
        assert_eq!((0..16).map(room_palette).collect::<HashSet<_>>().len(), 16);
        assert_eq!(room_palette(16), PaletteName::Sky);
    }

    #[test]
    fn light_palettes_keep_hue_and_deepen_each_stop() {
        for name in PaletteName::ALL {
            let dark = stops(name, EffectiveTheme::Dark);
            let light = stops(name, EffectiveTheme::Light);
            for (dark, light) in dark.into_iter().zip(light) {
                assert_eq!(dark.2, light.2);
                assert!(light.0 <= dark.0);
            }
            assert!(light[3].0 <= 0.92);
        }
        assert_eq!(
            stops(PaletteName::Sky, EffectiveTheme::Light),
            [
                Oklch(0.625, 0.170, 254.0),
                Oklch(0.788, 0.082, 237.2),
                Oklch(0.545, 0.188, 258.5),
                Oklch(0.92, 0.045, 171.8),
            ]
        );
    }

    #[test]
    fn uses_warm_dark_and_a_pure_white_page() {
        let dark = Colors::new(EffectiveTheme::Dark);
        let bytes = dark.background.into_rgba8();
        assert_eq!(bytes, [22, 22, 21, 255]);
        assert_eq!(Colors::new(EffectiveTheme::Light).background, Color::WHITE);
    }
}
