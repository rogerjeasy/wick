# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
