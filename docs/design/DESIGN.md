# Wick design system

One design language for Wick's three screens: her television (the Vega app, and the same source on
Fire OS), her television in a browser tab (`apps/ops-console/tv.html`), and the family app
(`apps/sim-alexa`). This file is the source of truth. A screen that disagrees with it is a bug in
the screen, or a change to this file in the same pull request.

## 1. What the design has to do

| Who | Where | What they need from the screen |
|---|---|---|
| Margaret, 78 | Her television, three metres away, one remote | To read every word without leaning forward, to know what OK will do before she presses it, and never to be startled. |
| Sarah, her daughter | The family app, mostly on a phone | One honest answer in a sentence, then one card; to know a press has been heard at once, even when the agent takes a while. |
| A judge | The browser television and the family app, side by side, or the Vega simulator with only a remote | To see what Wick does within a minute, without anyone driving the other side, and to know which parts are stand-ins. |

Principles, in the order they win:

1. **Legible first.** 32 pt is the television's floor and 7:1 its contrast floor (`packages/vega-calm-ui`). Nothing on any screen is cut, overflows, or scrolls sideways.
2. **One meaning per key.** A key does one thing on a screen, and the screen says what. Play over a card reads it aloud, every time; Play over a film plays or pauses it, every time.
3. **Every press answers at once.** The screen changes within 100 ms of a press — a pressed state, a progress line, the next card — even when the server takes seconds.
4. **Calm, never dead.** Motion explains where something came from or went, in 200 ms or less, and stops. Nothing loops, blinks, or moves by itself. Reduced motion means no motion.
5. **Honest about stand-ins.** Every simulated thing says so where it is seen, in words, not in a code comment.

## 2. Colour

Wick is a candle in a window: warm dark ground, warm white words, one amber flame.

### Her television (`packages/vega-calm-ui/src/tokens.ts`)

| Token | Value | Use | Contrast with `ink` |
|---|---|---|---|
| `ground` | `#12100E` | The screen | 16.8:1 |
| `raised` | `#1E1B17` | Cards, tiles, pills | 15.2:1 |
| `raisedHigh` | `#2A2621` | The focused tile's surface, the transport bar | 13.3:1 |
| `ink` | `#F4F1EA` | Words | — |
| `inkDim` | `#C8C2B6` | Quieter words | 10.7:1 on `ground`, 8.5:1 on `raisedHigh` |
| `accent` | `#E8B75D` | The first button, the progress fill, the flame. Words on it are `ground` (10.3:1). | — |
| `track` | `#4A443B` | The unfilled part of a progress bar (not text) | — |
| `scrim` | `#12100E` at 82 % | Over a film, behind a card | — |
| `focus` | `#FFFFFF` | The focus ring | — |

Higher contrast replaces every one of these with black and white (21:1), as it does today. No red,
anywhere, ever: red on a television means "something is wrong with you".

### The family app (`apps/sim-alexa/styles.css`)

The chrome follows Amazon's Alexa+ add-on design guide (it stands in for an Alexa+ surface); Wick's
own colour appears only on Wick's cards and final actions.

| Token | Value | Use |
|---|---|---|
| `--ground` | `#0B0E13` | Page |
| `--stage` | `#0F131A` | The surface |
| `--card` | `#151A21` | Cards |
| `--card-inner` | `#1C222B` | Rows inside a card |
| `--button` | `#2D415E` | Secondary buttons |
| `--ink` | `#F2F4F7` | Words, 15.9:1 on `--card` |
| `--ink-dim` | `#AEB7C4` | Quiet words, 8.6:1 on `--card` |
| `--line` | `#28303B` | Hairlines |
| `--wick` | `#E8B75D` | Final actions, the light, the flame |
| `--ok` | `#7FD1A0` | "Connected", "Done" ticks (always with a word or a tick, never colour alone) |

## 3. Type

| Surface | Family | Why |
|---|---|---|
| Her television (Vega, Fire OS) | The platform's own (Amazon Ember on Fire TV) | Designed for the screen it runs on; every layout number in `home/homeLayout.ts` is measured against it. |
| Browser television, family app | **Atkinson Hyperlegible Next**, self-hosted from `@fontsource-variable/atkinson-hyperlegible-next` | Drawn by the Braille Institute for readers with low vision: open counters, unambiguous I/l/1 and 0/O. Self-hosted: no request leaves the page for a font. |

Television sizes are the calm floor's: body 32, headline 48, display 64 (×1.25 with larger text).
The family app's scale is the Alexa+ guide's (body 16, headline 18, display 24, at 1.5× on a large
screen and 1× on a phone), with a 1.45 line height.

## 4. Motion

| Token | Value | Used for |
|---|---|---|
| `enterMs` | 200 | A card arriving: opacity 0→1 and 12 dp up |
| `exitMs` | 150 | A card leaving: opacity 1→0 |
| `focusMs` | 150 | A tile taking the focus: scale 1→1.04 (tiles only, never words alone) |
| `easing` | cubic-bezier(0.2, 0, 0, 1) | Everything that enters or moves |
| Hold feedback | linear, 2 s | Holding OK: the line fills as long as the key is held |

`prefers-reduced-motion` on the web, and Vega's reduce-motion setting on the television
(`useReduceMotionEnabled`), turn every one of these into an instant change. Nothing here is longer
than 200 ms except the hold line, which is the hold itself.

## 5. Icons

Lucide (`lucide-static`, ISC licence), one stroke weight, never an emoji. On the web they are inline
SVG built from a generated module; on the television they are PNGs rendered from the same SVGs at
build time (`sharp`), so neither platform needs a native module for them. An icon always stands
beside a word or carries an accessible label; it never stands alone for a meaning.

| Meaning | Lucide name |
|---|---|
| The door | `bell` |
| A note | `message-square` |
| Read aloud (Play) | `volume-2` |
| Her light | `flame` |
| Her mantelpiece | `image` |
| Easier to see | `eye` |
| How Wick works | `circle-help` |
| Play / Pause | `play` / `pause` |
| Hold for Sarah | `phone` |

## 6. The television's interaction model

The remote has six things: the D-pad, OK, Back, Play/Pause, and the two skip keys. Each means one
thing on each screen.

| Screen | ↑ ↓ | ← → | OK | Hold OK 2 s | Back | Play/Pause |
|---|---|---|---|---|---|---|
| Home | Move between rows | Move along a row | Open what is focused | Ask someone to ring her: a line fills while it is held, and a card asks before anything is sent | Leave Wick | Nothing |
| Film | Show the film's bar: title, time, how much is left | Skip 30 s back / forward, showing the bar | Play or pause | As on Home | Home, and the film remembers where it was | Play or pause |
| A card | Move between its buttons | Move between its buttons | Press the button | Nothing | "Not now": put it aside | Read the card aloud, or stop reading. Never the film. |
| The tour | — | — | Next | Nothing | Close the tour | Read the step aloud |

Rules that follow from the table:

- **The film's bar** (`watch/transport.ts`) shows the title, the time gone, and how long is left, with a progress line. It appears on pause, on a skip, and on ↑ or ↓, and goes after four seconds of play. While paused it stays.
- **Holding OK** shows its progress from 0.4 s, so a press that is becoming a hold can be seen and let go. Let go before 2 s, and nothing happens at all. At 2 s the card that asks "Ask Sarah to ring you?" comes, and the first second of it takes no press (`press/settle.ts`).
- **Home adapts to her** (`home/order.ts`): a film she stopped part-way is first, marked "Carry on" with how long is left and a progress line; then the films she watches most at this time of day; then the rest, in the catalogue's order. Nothing is guessed by a model, and nothing is sent anywhere.
- **The tour** (`tour/tour.ts`) is reached from a pill on the home screen, "How Wick works". It shows, with only the remote, an example of each thing Wick does — the door, a note at a calm point, holding OK, reading aloud — each marked "Example". Nothing in it is sent.

## 7. Layout

- **Television:** 960 × 540 dp, 48 dp from the sides and 32 dp from the top and bottom (inside the safe area). Three tiles at most in a row. `homeLayout.ts` measures every row, and its tests fail on anything that would not fit at 40 pt.
- **Browser television:** the same 960 × 540 screen, scaled to the window and letterboxed. Beside it on a wide window, and under it on a narrow one, a remote that can be pressed with a mouse or a finger, and a line that says what the page is: "A stand-in for Margaret's Fire TV, in your browser."
- **Family app:** one column on a phone (≥ 320 px, no sideways scroll at any width). From 1024 px, two columns: the conversation, and a panel about her home (her light, her televisions, who is expected). Suggestions are one row that scrolls inside itself with faded edges, plus "More" for the rest, grouped.

## 8. Libraries

| Library | Where | For |
|---|---|---|
| `@fontsource-variable/atkinson-hyperlegible-next` | Web | The typeface, self-hosted |
| `lucide-static` | Web, television (as PNGs) | Icons |
| `motion` | Web | Enter/exit and list animations, with reduced motion honoured |
| `open-props` | Web | Easing curves, shadows and the spacing scale |
| `sharp` (build only) | Television | Rendering icons to PNG |
| React Native `Animated` | Television | Enter/exit and focus animations: built into React Native, so the same code runs on Vega and on Fire OS with no native module |

## 9. Checks before a screen ships

- [ ] No word below the floor (32 pt on a television, 14 px on the web) and none under 7:1 on a television or 4.5:1 on the web.
- [ ] Nothing overflows at 320, 375, 768, 1024 and 1440 px wide (web), or at 40 pt (television).
- [ ] Every press changes the screen within 100 ms.
- [ ] Reduced motion makes every animation instant.
- [ ] Every stand-in says so on the screen.
- [ ] Every icon has a word beside it or an accessible label.
