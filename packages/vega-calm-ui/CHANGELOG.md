# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Larger text and higher contrast. `CalmPreferencesProvider` gives every
  component under it a theme (`useCalmTheme`, `useCalmStyles`, `CalmText`):
  larger text multiplies every size by 1.25 (32pt becomes 40pt); higher
  contrast is pure black and white (21:1, held to 15:1), a white card edge,
  every button outlined at rest and a 6dp focus ring. Each theme is checked
  when it is made (`checkTheme`).
- `fitCard`: at larger text a card takes the compact spacing, then a body-size
  headline, and falls back to the standard size rather than cut its words.
  `CalmCard` takes `mediaSize`, `childWords` and `childLines` so it can tell.
- `useHighTextContrastEnabled()` follows the platform's high-contrast text
  setting (Vega's `isHighTextContrastEnabled` and `highTextContrastChanged`).
- `announce(sentence)` hands a sentence to the screen reader.

### Changed

- `assertContrast` takes the ratio a theme promises; nothing passes under 7:1.
- `TwoPhaseCard` reserves its two lines at the theme's size.

## [0.1.0] — 2026-10-14

First public release, extracted from Wick, where these components draw every
card on a Fire TV (Vega OS) app for older people living alone.

### Added

- `CalmCard`: headline, optional detail and picture, up to three actions.
  Throws `CalmViolation` at render below 32pt type, below 7:1 contrast
  (card text and each button's own words), above three actions, with a
  saturated red accent, or when the card would not fit a 540dp screen.
- `TwoPhaseCard`: reserves the detail area (and with `mediaSize` the picture)
  at mount so late content displaces nothing; fades it in over 200ms, or not
  at all when the viewer asked for reduced motion.
- `useScreenReaderEnabled` and `useReduceMotionEnabled`, on Vega's
  `AccessibilityInfo`, and `watchAccessibility`, the plain function under them.
- The checks as functions (`assertContrast`, `assertActionLimit`,
  `assertItemLimit`, `assertCardFits`, `assertNoAlarmColour`, `fontSize`,
  `contrastRatio`, `alarmHue`, `cardHeightDp`) and the design tokens.
- `vega-calm-ui/eslint`: `min-font-size`, `no-alarm-colour`, `max-actions`
  and `no-auto-dismiss`, with a `recommended` flat config.
- Compiled ESM output with type declarations in `dist`; works on React Native
  and react-native-tvos through a Metro alias (see the README).

### Removed

- The planned `require-focus-order` rule: Vega's focus engine decides focus
  at run time, and a lint rule could only guess.
