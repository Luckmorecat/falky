# Native interface assets

- `Onest.ttf` is Onest Variable 2.001 (100–900) from Google Fonts at commit
  `4c1db3aec83c67dd223dd82a68c039cab30917a9`. The same typeface is used by
  `@fontsource-variable/onest` in the web client. `Onest-Native.ttc` has two
  FontTools instances at weight 450, the second with the font's tabular
  numeral substitution applied to its digits. Iced exposes named weights,
  so the collection supplies the web client's intermediate body weight.
  Both files use the adjacent Onest SIL Open Font License.
- `FalkyReactions.ttf` is a renamed FontTools subset of Noto Color Emoji
  2.051, taken from Debian `fonts-noto-color-emoji` 2.051-0+deb13u1. It
  preserves the six chat glyphs and U+FE0F and uses the adjacent SIL Open
  Font License.
- `icons/` contains the 24 × 24 path data and 2px rounded strokes from
  `web/src/ui/Icon.tsx` at the Phase 1 audited base, with colour set by iced.
