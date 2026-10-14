/**
 * A key that was already down when the home screen came back does nothing
 * when it is let go (apps/tv-vega/src/press/held.ts) — found here, on the
 * emulator: OK down in a playing film, Back 0.3 s later, OK let go 1.6,
 * 2.4 and 6 seconds after that, and the film under the focus started.
 *
 * Two things reach the app on Fire OS, and this runs the rule on both as
 * they really arrive:
 *
 *   - the focused item is told when OK goes down on it — once, for the
 *     first going down, never for a key already held — and when OK comes
 *     up on it, whether or not it saw it go down (react-native-tvos
 *     ReactViewGroup `onKeyDown` / `onKeyUp`);
 *   - the app hears keys through this app's adapter (remoteEvents.ts):
 *     nothing until a short press comes up; a held one as `longSelect`,
 *     down about 0.3 s late and then up; and nothing at all for a held key
 *     whose long press another key cut short, until it comes up
 *     (FRICTION.md FL-028).
 */
import { describe, expect, it } from 'vitest';
import { remoteKeyEvents } from '../adapters/remoteEvents.js';
import { okHeld, pressBegins, pressEnds } from '../../../tv-vega/src/press/held.js';
import { PRESS_SETTLE_MS } from '../../../tv-vega/src/press/settle.js';

const T = 1_800_000_000_000;

/** The home's focused film on Fire OS, and the app's ear for OK. `homeSince`: when the home came within reach, or null. */
function television() {
  const toKeys = remoteKeyEvents();
  const ok = okHeld();
  let began: number | null = null;
  const tv = {
    homeSince: null as number | null,
    started: 0,
    /** Android gives the app a key event. */
    android(eventType: string, eventKeyAction: number, now: number) {
      for (const key of toKeys({ eventType, eventKeyAction })) ok.seen(key, now);
    },
    /** The focused tile is told OK went down on it (press-in): HomeScreen `pressIn`. */
    pressIn(now: number) {
      began = pressBegins({ reachableSince: tv.homeSince, now, okDownSince: ok.since() });
    },
    /** The focused tile is told OK came up on it (press-out, then the press): HomeScreen `press`. */
    pressOut(now: number) {
      if (pressEnds({ keyCameUp: true, reachableSince: tv.homeSince, beganAt: began, now })) tv.started += 1;
      began = null;
    },
  };
  return tv;
}

describe('OK down in a film, Back, OK let go on the home screen', () => {
  for (const release of [700, 1_590, 1_600, 2_400, 6_000]) {
    for (const tileFirst of [true, false]) {
      it(`let go ${release} ms after Back: no film starts${tileFirst ? '' : ' (the app hears the key before the tile does)'}`, () => {
        const tv = television();
        // OK goes down in the film: the film's frame has the focus, the app hears nothing, and Back cuts the long
        // press short. The home comes back 0.3 s later with a film focused.
        tv.homeSince = T + 300;

        // OK comes up: the tile is told so, and the app hears a `select` coming up — its first word of this key.
        const up = T + 300 + release;
        if (tileFirst) tv.pressOut(up);
        tv.android('select', 1, up);
        if (!tileFirst) tv.pressOut(up);

        expect(tv.started).toBe(0);
      });
    }
  }

  it('the same when the long press was heard before Back: the app knew the key was down, and waits for it to come up', () => {
    const tv = television();
    // Down in the film at T; "longSelect" 0.3 s later; Back at 0.5 s.
    tv.android('longSelect', 0, T + 300);
    tv.homeSince = T + 500;

    tv.android('longSelect', 1, T + 3_000);
    tv.pressOut(T + 3_000);

    expect(tv.started).toBe(0);
  });

  it('the same when the long press is heard only after the home is back: the tile never saw the key go down', () => {
    const tv = television();
    tv.homeSince = T + 200;
    tv.android('longSelect', 0, T + 300);

    tv.pressOut(T + 3_000);
    tv.android('longSelect', 1, T + 3_000);

    expect(tv.started).toBe(0);
  });

  it('and her next press, begun on the home screen, starts the film', () => {
    const tv = television();
    tv.homeSince = T + 300;
    tv.android('select', 1, T + 2_700);
    tv.pressOut(T + 2_700);
    expect(tv.started).toBe(0);

    tv.pressIn(T + 4_000);
    tv.pressOut(T + 4_080);
    tv.android('select', 1, T + 4_080);

    expect(tv.started).toBe(1);
  });
});

describe('what stays as it was on Fire OS', () => {
  it('a short OK on the home screen — the app hears only the key coming up — starts the film, whichever is told first', () => {
    for (const tileFirst of [true, false]) {
      const tv = television();
      tv.homeSince = T;

      tv.pressIn(T + 5_000);
      if (tileFirst) tv.pressOut(T + 5_070);
      tv.android('select', 1, T + 5_070);
      if (!tileFirst) tv.pressOut(T + 5_070);

      expect(tv.started, String(tileFirst)).toBe(1);
    }
  });

  it('the home’s first second: a short OK seen 317 ms after it came back does nothing, and one at 1.1 s starts the film', () => {
    const tv = television();
    tv.homeSince = T;

    tv.pressIn(T + 240);
    tv.pressOut(T + 317);
    tv.android('select', 1, T + 317);
    expect(tv.started).toBe(0);

    tv.pressIn(T + PRESS_SETTLE_MS + 20);
    tv.pressOut(T + PRESS_SETTLE_MS + 100);
    tv.android('select', 1, T + PRESS_SETTLE_MS + 100);
    expect(tv.started).toBe(1);
  });

  it('a press on the home after a hold of her own there: the key heard going down late does not hold back the next press', () => {
    const tv = television();
    tv.homeSince = T;
    // Two seconds of OK begun on the home screen: the tile's own long press, and "longSelect" heard by the app.
    tv.pressIn(T + 5_000);
    tv.android('longSelect', 0, T + 5_300);
    tv.android('longSelect', 1, T + 7_400);

    tv.pressIn(T + 9_000);
    tv.pressOut(T + 9_080);
    tv.android('select', 1, T + 9_080);

    expect(tv.started).toBe(1);
  });
});
