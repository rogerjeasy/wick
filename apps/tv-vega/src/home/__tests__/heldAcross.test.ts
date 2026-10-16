/**
 * A key that was already down when the home screen came back does nothing
 * when it is let go, however late (press/held.ts, home/HomeScreen.tsx).
 *
 * Seen on the Fire OS emulator on main e67b1fe: OK down in a playing film,
 * Back 0.3 s later, OK kept down, then let go. Within about 0.7 s of Back:
 * nothing. At 1.6 s, 2.4 s and 6 s: Big Buck Bunny started, from the
 * beginning, at the release.
 *
 * The two televisions are told about a key in different ways, and both are
 * played here:
 *
 *   - The focused item is told when OK goes down on it and when OK comes up
 *     on it (the platform's press-in and press-out). On Fire OS press-in is
 *     sent for the first going down only, never for a key already held
 *     (ReactViewGroup.onKeyDown, `repeatCount == 0`), and press-out for any
 *     coming up — which is how a tile was pressed by a key it never saw go
 *     down. Vega's press handlers have the same shape; what it does for a
 *     key held across a change of focus has not been seen, so both answers
 *     are played.
 *   - The app hears keys too (useTVEventHandler). On Vega: down, down again
 *     while held, up. On Fire OS: nothing until the key comes up, for a
 *     short press; for a held one, "down" about 0.3 s late and then "up" —
 *     unless another key cut the long press short, as Back did here, and
 *     then again nothing until it comes up. The shapes are written out
 *     below as the Fire OS adapter says them (FRICTION.md FL-028);
 *     apps/tv-fireos/src/__tests__/heldAcross.test.ts runs the same rule on
 *     the adapter itself.
 *
 * So the rule stands on what both are told: a press acts only if it began
 * on the home — and, where the app did hear the key go down before the home
 * came back, it waits for that key to come up, as the guard for the hold
 * does (home/reach.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDLE_OFF, idleOnKey, type Idle } from '../../mantel/idle.js';
import { okHeld, pressBegins, pressEnds } from '../../press/held.js';
import { PRESS_SETTLE_MS } from '../../press/settle.js';
import { HOLD_MS } from '../../watch/hold.js';
import { homeBehind } from '../behind.js';
import { HOME_FOCUS_START, reachChanged, type HomeFocus } from '../focusMemory.js';

const T = 1_800_000_000_000;
type Platform = 'vega' | 'fireos';
interface Shape {
  readonly platform: Platform;
  /** Vega, if it should tell a newly focused item that a held key is "going down" on it as the key repeats. */
  readonly pressInOnRepeat?: boolean;
  /** Fire OS, when nothing cut the long press short: the app hears "down" 0.3 s after the key really went down. */
  readonly longPressHeard?: boolean;
}
const SHAPES: readonly Shape[] = [{ platform: 'fireos' }, { platform: 'fireos', longPressHeard: true }, { platform: 'vega' }, { platform: 'vega', pressInOnRepeat: true }];
const named = (shape: Shape): string =>
  `${shape.platform}${shape.pressInOnRepeat ? ' (press-in on repeat)' : ''}${shape.longPressHeard ? ' (long press heard)' : ''}`;
/** How long Android waits before it calls a held key a long press (ReactAndroidHWInputDeviceHelper `mLongPressedDelta`). */
const ANDROID_LONG_PRESS_MS = 300;

/** The resident's television: what ResidentApp and HomeScreen do with OK, without React. */
function television(shape: Shape) {
  let focus: HomeFocus = HOME_FOCUS_START;
  /** HomeScreen's `began`: when the press under way began on it, or null. Gone with the screen. */
  let began: number | null = null;
  /** The platform's own long press on the focused item: runs from press-in. */
  let longPressFrom: number | null = null;
  let longPressSent = false;
  /** Whether OK is physically down, and whether the home had the focus when it went down. */
  let physicallyDown = false;
  let downAt = 0;
  /** Fire OS: whether the app has been told this key is down. */
  let heardDown = false;
  const ok = okHeld();
  /** The app hears a key (ResidentApp's handler): what OK is doing, and the idle screen's rule. */
  const hears = (eventKeyAction: number, now: number): void => {
    const event = { eventType: shape.platform === 'vega' ? 'enter' : 'select', eventKeyAction };
    ok.seen(event, now);
    tv.idle = idleOnKey(tv.idle, event, now);
  };
  const tv = {
    card: null as string | null,
    mantelOpen: false,
    idle: IDLE_OFF as Idle,
    onScreen: true,
    watching: false,
    started: 0,
    holds: 0,
    /** Whether a home item has the focus: the rows are drawn and within reach. */
    homeFocused: () => !tv.watching && focus.reachableSince !== null,
    /** The screen is drawn. */
    draw(now: number) {
      if (tv.watching) {
        // No home screen at all while a film is on: when it comes back it is a new one.
        focus = HOME_FOCUS_START;
        began = null;
        longPressFrom = null;
        return tv;
      }
      const behind = homeBehind({ card: tv.card !== null, mantelOpen: tv.mantelOpen, idle: tv.idle });
      // The rows are left out behind a card: the items, and what they had begun, are gone.
      if (!behind.rows) {
        began = null;
        longPressFrom = null;
      }
      focus = reachChanged(focus, behind.rows && behind.reach && tv.onScreen, now);
      if (!tv.onScreen) ok.forget();
      return tv;
    },
    /** HomeScreen `pressIn`. */
    pressIn(now: number) {
      began = pressBegins({ reachableSince: focus.reachableSince, now, okDownSince: ok.since() });
      longPressFrom = now;
      longPressSent = false;
    },
    /** HomeScreen `press`, called by the platform when OK comes up on the item — unless that was a long press. */
    pressOut(now: number) {
      const wasLongPress = longPressSent;
      longPressFrom = null;
      longPressSent = false;
      if (wasLongPress) return;
      if (pressEnds({ keyCameUp: true, reachableSince: focus.reachableSince, beganAt: began, now })) tv.started += 1;
      began = null;
    },
    /** Time passes with OK down: the platform's long press fires two seconds after press-in, and a held key repeats. */
    held(now: number) {
      if (!physicallyDown) return tv;
      if (shape.platform === 'vega') {
        hears(0, now);
        if (shape.pressInOnRepeat && tv.homeFocused() && longPressFrom === null) tv.pressIn(now);
      } else if (shape.longPressHeard && !heardDown && now - downAt >= ANDROID_LONG_PRESS_MS) {
        // "longSelect" going down, which the adapter says as OK going down.
        heardDown = true;
        hears(0, now);
      }
      if (tv.homeFocused() && longPressFrom !== null && !longPressSent && now - longPressFrom >= HOLD_MS) {
        longPressSent = true;
        tv.holds += 1;
      }
      return tv;
    },
    /** OK goes down. */
    down(now: number) {
      physicallyDown = true;
      downAt = now;
      heardDown = false;
      // Fire OS tells the app nothing now. Vega says the key is going down.
      if (shape.platform === 'vega') hears(0, now);
      // The focused item is told on both — if a home item has the focus.
      if (tv.homeFocused()) tv.pressIn(now);
      return tv;
    },
    /** OK comes up. `itemFirst`: whether the focused item hears of it before the app does — neither order is promised. */
    up(now: number, itemFirst = true) {
      physicallyDown = false;
      const app = (): void => {
        // Fire OS, a key the app never heard go down: the adapter says the whole press now — down, then up.
        if (shape.platform === 'fireos' && !heardDown) hears(0, now);
        hears(1, now);
      };
      const item = (): void => {
        if (tv.homeFocused()) tv.pressOut(now);
      };
      if (itemFirst) {
        item();
        app();
      } else {
        app();
        item();
      }
      return tv.draw(now);
    },
    /** A press of her own: down and up, eighty milliseconds apart. */
    press(now: number) {
      tv.down(now - 80);
      return tv.up(now);
    },
  };
  return tv.draw(T);
}

describe('the sequence seen on the emulator — OK down in a film, Back, OK let go', () => {
  for (const shape of SHAPES) {
    for (const itemFirst of [true, false]) {
      for (const release of [700, 1_590, 1_600, 2_400, 6_000, 30_000]) {
        it(`${named(shape)}: let go ${release} ms after Back starts no film${itemFirst ? '' : ' (the app hears the key first)'}`, () => {
          const tv = television(shape);
          tv.watching = true;
          tv.draw(T + 10_000);

          // OK down in the playing film; Back 0.3 s later closes it; OK is still down.
          tv.down(T + 60_000);
          tv.watching = false;
          const back = T + 60_300;
          tv.draw(back);
          for (let at = 100; at < release; at += 100) tv.held(back + at).draw(back + at);

          tv.up(back + release, itemFirst);

          expect(tv.started).toBe(0);
          // Nor is it the hold: a hold is two seconds of OK begun on the home screen. (The hold is the platform's
          // own long press and is left exactly as it was — nothing may cost her that one. So if Vega does tell a
          // newly focused item that a held key is going down on it, the offer would come, as it would have before.)
          if (!shape.pressInOnRepeat) expect(tv.holds).toBe(0);
        });
      }
    }

    it(`${named(shape)}: and the next press, her own, starts the film`, () => {
      const tv = television(shape);
      tv.watching = true;
      tv.draw(T + 10_000);
      tv.down(T + 60_000);
      tv.watching = false;
      tv.draw(T + 60_300);
      tv.held(T + 61_000).up(T + 62_700);
      expect(tv.started).toBe(0);

      tv.press(T + 64_000);

      expect(tv.started).toBe(1);
    });
  }
});

describe('every way the home screen comes back, with OK already down', () => {
  const ways: Record<string, (tv: ReturnType<typeof television>, at: number) => void> = {
    'a film closed with Back': (tv, at) => {
      tv.watching = false;
      tv.draw(at);
    },
    'a film that ended by itself': (tv, at) => {
      tv.watching = false;
      tv.draw(at);
    },
    'a card taken back from another room': (tv, at) => {
      tv.card = null;
      tv.draw(at);
    },
    'her mantelpiece closed': (tv, at) => {
      tv.mantelOpen = false;
      tv.draw(at);
    },
    'Wick back from behind another app': (tv, at) => {
      tv.onScreen = true;
      tv.draw(at);
    },
  };
  const away: Record<string, (tv: ReturnType<typeof television>) => void> = {
    'a film closed with Back': (tv) => void (tv.watching = true),
    'a film that ended by itself': (tv) => void (tv.watching = true),
    'a card taken back from another room': (tv) => void (tv.card = 'note-1'),
    'her mantelpiece closed': (tv) => void (tv.mantelOpen = true),
    'Wick back from behind another app': (tv) => void (tv.onScreen = false),
  };

  for (const shape of SHAPES) {
    for (const [way, back] of Object.entries(ways)) {
      it(`${named(shape)}: ${way} — let go two and six seconds later, nothing starts; then her own press does`, () => {
        for (const release of [2_000, 6_000]) {
          const tv = television(shape);
          away[way]!(tv);
          tv.draw(T + 10_000);
          // OK goes down while the home is away, and is still down when it comes back.
          tv.down(T + 20_000);
          back(tv, T + 20_300);
          for (let at = 100; at < release; at += 100) tv.held(T + 20_300 + at).draw(T + 20_300 + at);

          tv.up(T + 20_300 + release);
          expect(tv.started, `${release}`).toBe(0);

          tv.press(T + 20_300 + release + 1_500);
          expect(tv.started, `${release}`).toBe(1);
        }
      });
    }

    it(`${named(shape)}: the idle screen ended by OK held down — the home stays out of reach until it is up, and the release starts nothing`, () => {
      const tv = television(shape);
      tv.idle = { phase: 'on', startedAt: T + 180_000 };
      tv.draw(T + 180_000);

      tv.down(T + 240_000);
      // Vega ends her pictures now; Fire OS when it hears of the key — 0.3 s on, or not until it comes up.
      tv.draw(T + 240_000);
      for (let at = 100; at < 3_000; at += 100) tv.held(T + 240_000 + at).draw(T + 240_000 + at);
      tv.up(T + 243_000);

      expect(tv.idle).toBe(IDLE_OFF);
      expect(tv.started).toBe(0);
      // And then the home's own second, and her own press after it.
      tv.press(T + 243_400);
      expect(tv.started).toBe(0);
      tv.press(T + 244_200);
      expect(tv.started).toBe(1);
    });
  }
});

describe('what stays as it was', () => {
  for (const shape of SHAPES) {
    it(`${named(shape)}: a press of her own on the home screen starts the film`, () => {
      const tv = television(shape);

      tv.press(T + 5_000);

      expect(tv.started).toBe(1);
    });

    it(`${named(shape)}: the home’s first second — a press seen 317 ms after it came back does nothing, one at 1.1 s starts the film`, () => {
      const tv = television(shape);
      tv.card = 'note-1';
      tv.draw(T + 30_000);
      tv.card = null;
      tv.draw(T + 40_000);

      tv.press(T + 40_317);
      expect(tv.started).toBe(0);
      tv.press(T + 41_100);
      expect(tv.started).toBe(1);
    });

    it(`${named(shape)}: a press begun inside that second and let go after it is acted on, as before`, () => {
      const tv = television(shape);
      tv.card = 'note-1';
      tv.draw(T + 30_000);
      tv.card = null;
      tv.draw(T + 40_000);

      tv.down(T + 40_920);
      tv.up(T + 40_000 + PRESS_SETTLE_MS);

      expect(tv.started).toBe(1);
    });

    it(`${named(shape)}: OK held for two seconds, begun on the home screen — even 300 ms after it came back — is the hold, and not a press`, () => {
      const tv = television(shape);
      tv.card = 'note-1';
      tv.draw(T + 30_000);
      tv.card = null;
      tv.draw(T + 40_000);

      tv.down(T + 40_300);
      for (let at = 100; at <= HOLD_MS + 200; at += 100) tv.held(T + 40_300 + at);
      tv.up(T + 40_300 + HOLD_MS + 300);

      expect(tv.holds).toBe(1);
      expect(tv.started).toBe(0);
    });

    it(`${named(shape)}: whichever hears the key come up first, the app or the item, her own press is acted on`, () => {
      for (const itemFirst of [true, false]) {
        const tv = television(shape);
        tv.down(T + 5_000);
        tv.up(T + 5_090, itemFirst);
        expect(tv.started, String(itemFirst)).toBe(1);
      }
    });
  }

  it('Fire OS: a short OK — only the key coming up reaches the app — is still a press, because the item saw it go down', () => {
    const tv = television({ platform: 'fireos' });

    tv.down(T + 5_000);
    tv.up(T + 5_060, false);

    expect(tv.started).toBe(1);
  });
});

describe('HomeScreen.tsx — a press begins and ends on the item', () => {
  const screen = readFileSync(fileURLToPath(new URL('../HomeScreen.tsx', import.meta.url)), 'utf8');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

  it('tells every item that can be pressed when OK goes down on it', () => {
    expect(code.match(/onPressIn=\{pressIn\}/g)).toHaveLength(5);
    expect(code.match(/<Pressable\b/g)).toHaveLength(5);
  });

  it('begins a press only by the rule — with what the app heard of the key', () => {
    expect(code).toMatch(/began\.current = pressBegins\(\{ reachableSince: focus\.current\.reachableSince, now: Date\.now\(\), okDownSince: okDownSince\?\.\(\) \?\? null \}\);/);
  });

  it('acts on a press only by the rule, and a press ends once', () => {
    expect(code).toMatch(/const acts = pressEnds\(\{ keyCameUp: byKey, reachableSince: focus\.current\.reachableSince, beganAt: began\.current, now: Date\.now\(\) \}\);\s*began\.current = null;\s*if \(acts\) act\?\.\(\);/);
  });

  it('keeps what began with the screen itself: it is forgotten when the screen is taken down for a film', () => {
    expect(code).toMatch(/const began = React\.useRef<number \| null>\(null\);/);
  });

  it('knows a key coming up from a press with no key: the platform says the key came up, and then — at once — the press', () => {
    expect(code.match(/onPressOut=\{pressOut\}/g)).toHaveLength(5);
    expect(code).toMatch(/const pressOut = \(\): void => \{\s*keyCameUp\.current = true;\s*onKeyUp\?\.\(\);\s*\};/);
    expect(code).toMatch(/const byKey = keyCameUp\.current;\s*keyCameUp\.current = false;/);
    // The app is still told every time OK comes up here: the guard for the hold goes by it (home/reach.ts).
    expect(code).not.toMatch(/onPressOut=\{onKeyUp\}/);
  });
});

describe('ResidentApp.tsx — what the app hears of OK', () => {
  const app = readFileSync(fileURLToPath(new URL('../../ResidentApp.tsx', import.meta.url)), 'utf8');
  const handler = app.slice(app.indexOf('useTVEventHandler((event) => {'), app.indexOf('\n  });', app.indexOf('useTVEventHandler((event) => {')));

  it('is heard where every key is heard, whatever is on screen — a film too', () => {
    expect(app).toMatch(/const okKey = React\.useMemo\(\(\) => okHeld\(\), \[\]\);/);
    expect(handler).toMatch(/okKey\.seen\(event, now\);/);
  });

  it('is given to the home screen, and forgotten when Wick goes behind another app', () => {
    const home = app.slice(app.indexOf('<HomeScreen'), app.indexOf('/>', app.indexOf('<HomeScreen')));

    expect(home).toMatch(/okDownSince=\{okKey\.since\}/);
    expect(app).toMatch(/if \(!onScreen\) okKey\.forget\(\);/);
  });
});
