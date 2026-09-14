# vega-calm-ui

Accessible, low-arousal 10-foot components for **Vega OS** and Fire TV.

Extracted from [Wick](https://github.com/rogerjeasy/wick). Built because every TV
component library assumes a viewer with good eyesight, quick reactions and a
tolerance for motion — and the people who most need a television to be usable
have none of those.

> **Open Source mini-challenge submission.** Publish this, then open a PR against
> `AmazonAppDev/react-native-multi-tv-app-sample` adding an accessibility preset
> theme. PRs do not need to be merged.

## What it gives you

- **`CalmCard`** — minimum 32pt type, ≥7:1 contrast, at most three actions, no
  auto-dismiss, no timers, no red, no badges.
- **`TwoPhaseCard`** — render immediately with what you have, patch in the slow
  part when it arrives. Built for the case where a vision model might take two
  seconds and might never answer.
- **Safe-area-aware positioning** for TV overscan.
- **No-startle animation curves** — nothing over 200ms, nothing that flashes.
- **`tokens`** — a palette that is high-contrast without being harsh.
- **ESLint rules** for `@amazon-devices/eslint-plugin-kepler` that flag focus-order
  mistakes and auto-dismissing surfaces.

## Install

```bash
npm install @wick/vega-calm-ui
```

## Why the constraints are hard-coded

They are not configurable because a configurable accessibility floor is not a
floor. If you need 24pt type, this is not the library for you.

## Licence

MIT
