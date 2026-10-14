# vega-calm-ui

> **Canonical repository: [github.com/rogerjeasy/vega-calm-ui](https://github.com/rogerjeasy/vega-calm-ui)**
> (`npm install vega-calm-ui`). This folder is Wick's workspace copy,
> imported as `@wick/vega-calm-ui` and kept identical to it in `src/` and
> `eslint/`; changes go upstream first.

Accessible, low-arousal 10-foot components for **Vega OS** (Fire TV), with an
ESLint plugin that catches the same mistakes before your code runs.

[![CI](https://github.com/rogerjeasy/vega-calm-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/rogerjeasy/vega-calm-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

```tsx
import { CalmCard } from 'vega-calm-ui';

<CalmCard
  headline="Sarah is at the door"
  detail="She is holding a bag of shopping."
  actions={[
    { id: 'answer', label: 'Talk to her', kind: 'primary' },
    { id: 'later', label: 'Not now', kind: 'dismiss' },
  ]}
  onAction={(id) => handle(id)}
/>;
```

That card cannot be drawn with 24pt text, with text below 7:1 contrast, with a
fourth button, or in red. It throws instead. And the ESLint rules flag the
same card in your editor before it ever reaches a television.

## Why

Most television UI assumes a viewer with good eyesight, quick reactions and a
tolerance for motion: small captions, tiles that animate on focus, toasts that
disappear after five seconds, red badges that mean "look at me now". For a
lot of people who watch the most television — older viewers, people with low
vision, cataracts or a tremor, people who read slowly — that is the
difference between a screen they can use and one that startles them.

Ten feet from a 50-inch screen, 32pt is about the smallest type that stays
comfortable to read; WCAG AAA asks for 7:1 contrast for low-vision readers; a
remote control makes every extra button another decision; and on a television
in a living room, red reads as "something is wrong". This package takes those
as a floor rather than as advice. A floor that can be configured is not a
floor, so the limits are constants, not options.

It was extracted from [Wick](https://github.com/rogerjeasy/wick), a Fire TV
app for older people living alone, where every card on the screen — who is at
the door, a note from the family, the week's summary — is drawn with it.

## What is in it

| Export | What it is |
| --- | --- |
| `CalmCard` | The base surface: a headline, optional detail, up to three actions, optional picture beside the words. Throws a `CalmViolation` at render if the floor is broken. |
| `TwoPhaseCard` | Render what you have now, patch the slow part in later without moving anything already on screen. The detail area (and, with `mediaSize`, the picture) is reserved at mount. |
| `useScreenReaderEnabled()` | Whether VoiceView (Fire TV), TalkBack or VoiceOver is on, followed live. |
| `useReduceMotionEnabled()` | Whether the viewer asked for less motion. `TwoPhaseCard` uses it to skip its fade. |
| `watchAccessibility()` | The logic under both hooks, as a plain function you can test or use outside React. |
| `assertContrast`, `assertActionLimit`, `assertItemLimit`, `assertCardFits`, `assertNoAlarmColour`, `fontSize`, `contrastRatio`, `alarmHue`, `cardHeightDp` | The checks themselves, for your own components. |
| `type`, `palette`, `layout`, `limits`, `motion`, `contrast` | The tokens. |
| `vega-calm-ui/eslint` | Four ESLint rules and a `recommended` config. |

## Install

```bash
npm install vega-calm-ui
```

Peer dependencies: `react` (18.2 or 19), and on Vega
`@amazon-devices/react-native-kepler` (which every Vega app already has).
`eslint` 9 or later if you use the rules.

### On React Native, Android TV, Fire OS and tvOS

The components use only `View`, `Text`, `Pressable`, `Animated`, `StyleSheet`
and `AccessibilityInfo`, which `react-native` and `react-native-tvos` export
under the same names and with the same props. Point the Vega import at React
Native in `metro.config.js`:

```js
const { getDefaultConfig } = require('@react-native/metro-config'); // or require('expo/metro-config')

const config = getDefaultConfig(__dirname);
const resolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@amazon-devices/react-native-kepler') {
    return context.resolveRequest(context, 'react-native', platform);
  }
  return (resolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
```

Wick's own Fire OS build runs these components on react-native-tvos this
way. In Jest, the equivalent is
`moduleNameMapper: { '^@amazon-devices/react-native-kepler$': 'react-native' }`.

## Usage

### A card

```tsx
import { CalmCard } from 'vega-calm-ui';

export function DoorCard({ who, onAnswer }: { who: string; onAnswer: (id: string) => void }) {
  return (
    <CalmCard
      headline={`${who} is at the door`}
      actions={[
        { id: 'look', label: 'Show me', kind: 'primary' },
        { id: 'later', label: 'Not now', kind: 'dismiss' },
      ]}
      onAction={onAnswer}
    />
  );
}
```

The first action takes the remote's focus (`hasTVPreferredFocus`); pass
`initialFocusId` to choose another. Focus is shown as a white ring, never as
a change of colour alone. The primary button is amber with dark words on it
(about 10:1); the others are light words on the dark ground.

A card over a programme can be `compact`: less padding and a body-size bold
headline, never smaller type. A card whose detail must be read whole can ask
for more than five lines with `detailLines`, and gets them only if, at 32pt,
the card still fits a 960x540dp screen with its margins.

### Two phases

```tsx
import { TwoPhaseCard } from 'vega-calm-ui';

<TwoPhaseCard
  headline="Someone is at the door"
  detail={description /* undefined until the slow call answers, and maybe forever */}
  media={photo && <Image source={{ uri: photo }} style={{ width: 288, height: 162 }} />}
  mediaSize={{ width: 288, height: 162 }}
  actions={actions}
  onAction={onAction}
/>;
```

`detail` absent means "nothing has arrived, and possibly never will" — a
supported end state, not a loading condition. There is no spinner and no
"Loading…". When it arrives it fades in over 200ms in space that was already
reserved, or appears at once if the viewer asked for reduced motion.

### Screen reader and reduced motion

```tsx
import { useScreenReaderEnabled } from 'vega-calm-ui';

const screenReader = useScreenReaderEnabled();
// e.g. keep a card on screen until it is answered, never assume it was read.
```

On Vega both settings are read from `AccessibilityInfo` in
`@amazon-devices/react-native-kepler`. Vega emits `screenReaderChanged` but
not `reduceMotionChanged`, so on Vega reduced motion is read when the hook
mounts and not followed afterwards; on Android TV and tvOS both are followed
live. Both hooks return `false` until the platform answers, and stay `false`
on a platform that cannot answer: an unknown setting is never reported as on.

## What the checks enforce

| Check | Rule | Where |
| --- | --- | --- |
| `fontSize(role)` | Nothing below 32pt | Every text style in the components |
| `assertContrast(fg, bg)` | At least 7:1 (WCAG AAA), computed, not assumed | Card text on the card, and every button's words on that button |
| `assertActionLimit(n)` / `assertItemLimit(n)` | At most three | `CalmCard` actions |
| `assertCardFits(shape)` | The card, at 32pt, fits a 540dp-tall screen with 32dp clear above and below, so the buttons can never be pushed off | `CalmCard` (`detailLines`, `compact`) |
| `assertNoAlarmColour(hex)` | No saturated red, caught by hue (the wedge 345–12deg, over 35% saturation), so a new shade is caught like `#FF0000` | The palette's accent |

A broken floor throws `CalmViolation` during render.

**Should you turn them off in production?** No, and there is no switch. The
checks are a few arithmetic operations per render and they only throw for a
programmer's mistake (a fourth action, a token edited below AAA), never for
anything a viewer does. The alternative to a thrown error is a 24pt label
shipped to someone with cataracts. Put an error boundary around wherever you
host cards, and use the ESLint rules below so the mistakes are caught before
they reach a build at all.

## The tokens

| Token | Value | Why |
| --- | --- | --- |
| `type.bodyPt` | 32 | The floor for anything a viewer reads |
| `type.headlinePt` | 48 | Card headlines |
| `type.displayPt` | 64 | One word or number on its own |
| `contrast.minRatio` | 7 | WCAG AAA |
| `limits.maxActions` | 3 | Three buttons, never four |
| `limits.maxListItems` | 3 | The same for lists on a card |
| `limits.maxDetailLines` | 5 | Detail is cut so the buttons stay on screen |
| `motion.durationMs` | 200 | Nothing longer, nothing that flashes |
| `layout.screenHeightDp` | 540 | Vega's logical screen height |
| `layout.screenMarginDp` | 32 | Kept clear above and below a card (overscan) |
| `palette.ink` | `#F4F1EA` | Main text: 15.2:1 on `raised` |
| `palette.inkDim` | `#C8C2B6` | Secondary text: 9.7:1 on `raised` |
| `palette.ground` | `#12100E` | Screen and button ground |
| `palette.raised` | `#1E1B17` | Card surface |
| `palette.accent` | `#E8B75D` | Amber, the primary button. Warm without being an alarm |
| `palette.focus` | `#FFFFFF` | The focus ring |

## ESLint rules

```js
// eslint.config.js
import calm from 'vega-calm-ui/eslint';

export default [
  // ...your config
  { ...calm.configs.recommended, files: ['src/**/*.tsx'] },
];
```

`recommended` turns all four on as errors. The rules work with the default
parser and with `typescript-eslint`'s.

### `min-font-size`

A literal `fontSize` below 32 in any object — `StyleSheet.create`, an inline
style. `fontSize: fontSize('body')` and computed values are not judged.
Option: `{ min: number }`.

### `no-alarm-colour`

A saturated red written as `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` or
`rgba()` anywhere, or a red colour keyword (`red`, `crimson`, `tomato`, …) in
a colour style key or prop. It uses the same hue test as
`assertNoAlarmColour`; a test holds the two to the same answer on a
4096-colour sweep. Coral and orange-red are orange by that test and pass.

### `max-actions`

More than three actions written out on `<CalmCard>` or `<TwoPhaseCard>`.
Actions built elsewhere are left to the render-time check. Options:
`{ max: number, components: string[] }`.

### `no-auto-dismiss`

`setTimeout` or `setInterval` (bare, or on `window` / `global` /
`globalThis`) anywhere inside a component — function or class, including its
effects and callbacks — that renders a calm card. A calm card stays until the
viewer answers it. Option: `{ components: string[] }` to add your own
surfaces. It cannot see a timer started in a hook defined in another file.

A fifth rule, for focus order, was planned and dropped: Vega's focus engine
and `hasTVPreferredFocus` decide focus at run time, and a lint rule could only
guess.

## Contributing

Issues and pull requests are welcome.

```bash
npm ci
npm run verify   # typecheck, lint, test, build
```

- The floor does not move down. A change that makes the minimums
  configurable, or lower, will be declined; a change that catches more
  mistakes is very welcome.
- Every rule and check comes with tests. Rule tests use ESLint's `RuleTester`
  under Vitest (`src/__tests__/eslint.test.ts`); component tests read
  `CalmCard`'s element tree directly, with the Vega components stood in for,
  so no device or emulator is needed.
- Keep `eslint/colour.js` and `alarmHue` in `src/constraints.ts` in step; the
  sweep test fails if they disagree.
- Conventional commit messages (`feat:`, `fix:`, `docs:` …).

## Licence

[MIT](./LICENSE)
