/**
 * A press acts only if its key went down on the thing pressed
 * (press/held.ts).
 *
 * Seen on the Fire OS emulator on main e67b1fe: OK down in a playing film,
 * Back a third of a second later, OK kept down. The home screen came back
 * with the focus on a film, and when OK was let go — 1.6, 2.4 and 6 seconds
 * later — the film started. The key coming up is given to whatever has the
 * focus, and the film's tile took it for a press it had never seen begin.
 *
 * Everything here is plain code. The two televisions' key paths are spelt
 * out in home/__tests__/heldAcross.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { okHeld, pressBegins, pressEnds } from '../held.js';
import { PRESS_SETTLE_MS } from '../settle.js';

const BACK = 1_800_000_000_000;
const DOWN = 0;
const UP = 1;
const key = (eventType: string, eventKeyAction?: number) => ({ eventType, ...(eventKeyAction === undefined ? {} : { eventKeyAction }) });

describe('pressBegins — the key goes down on something on the home screen', () => {
  it('begins a press when the home is within the remote’s reach', () => {
    expect(pressBegins({ reachableSince: BACK, now: BACK + 5_000, okDownSince: null })).toBe(BACK + 5_000);
  });

  it('begins one in the home’s first second too: whether it is acted on is decided when the key comes up, as before', () => {
    expect(pressBegins({ reachableSince: BACK, now: BACK + 300, okDownSince: null })).toBe(BACK + 300);
  });

  it('begins nothing while the home is out of reach', () => {
    expect(pressBegins({ reachableSince: null, now: BACK, okDownSince: null })).toBeNull();
  });

  it('begins nothing for a key that was already down when the home came back — whatever says it is going down now', () => {
    expect(pressBegins({ reachableSince: BACK, now: BACK + 1_500, okDownSince: BACK - 300 })).toBeNull();
    expect(pressBegins({ reachableSince: BACK, now: BACK + 6_000, okDownSince: BACK - 300 })).toBeNull();
  });

  it('begins one for a key the app heard go down a moment before the item did: it is the same key going down', () => {
    expect(pressBegins({ reachableSince: BACK, now: BACK + 5_010, okDownSince: BACK + 5_000 })).toBe(BACK + 5_010);
    expect(pressBegins({ reachableSince: BACK, now: BACK + 5_000, okDownSince: BACK })).toBe(BACK + 5_000);
  });

  it('is not begun by a clock that went back', () => {
    expect(pressBegins({ reachableSince: BACK, now: BACK - 1, okDownSince: null })).toBeNull();
  });
});

describe('pressEnds — the key comes up on it', () => {
  it('is acted on when the press began on the home, since it came back, and the home’s second is over', () => {
    expect(pressEnds({ keyCameUp: true, reachableSince: BACK, beganAt: BACK + 1_020, now: BACK + 1_100 })).toBe(true);
  });

  it('does nothing when no press began here: the key was down before the home came back — however late it is let go', () => {
    for (const late of [700, 1_600, 2_400, 6_000, 60_000]) {
      expect(pressEnds({ keyCameUp: true, reachableSince: BACK, beganAt: null, now: BACK + late }), String(late)).toBe(false);
    }
  });

  it('keeps the home’s first second, by the one timing rule: a press seen inside it does nothing', () => {
    expect(pressEnds({ keyCameUp: true, reachableSince: BACK, beganAt: BACK + 240, now: BACK + 317 })).toBe(false);
    expect(pressEnds({ keyCameUp: true, reachableSince: BACK, beganAt: BACK + 900, now: BACK + PRESS_SETTLE_MS - 1 })).toBe(false);
    // Begun inside the second and let go after it: acted on, as it was before.
    expect(pressEnds({ keyCameUp: true, reachableSince: BACK, beganAt: BACK + 920, now: BACK + PRESS_SETTLE_MS })).toBe(true);
  });

  it('does nothing for a press begun before the home last came back: it went away and returned in between', () => {
    expect(pressEnds({ keyCameUp: true, reachableSince: BACK + 10_000, beganAt: BACK + 5_000, now: BACK + 12_000 })).toBe(false);
  });

  it('does nothing while the home is out of reach', () => {
    expect(pressEnds({ keyCameUp: true, reachableSince: null, beganAt: BACK + 5_000, now: BACK + 5_100 })).toBe(false);
  });
});

describe('pressEnds — a press with no key coming up on the item', () => {
  // The platform can also press an item without a key: its "click", which is how something that is not the
  // remote — a screen reader — presses what has the focus. There is no key to have been held from elsewhere.
  it('is judged by the home’s first second alone, as every press was before: it needs no beginning', () => {
    expect(pressEnds({ keyCameUp: false, reachableSince: BACK, beganAt: null, now: BACK + 5_000 })).toBe(true);
    expect(pressEnds({ keyCameUp: false, reachableSince: BACK, beganAt: null, now: BACK + 317 })).toBe(false);
    expect(pressEnds({ keyCameUp: false, reachableSince: null, beganAt: null, now: BACK + 5_000 })).toBe(false);
  });
});

describe('okHeld — since when OK has been down, as far as the keys the app hears say', () => {
  it('is not down until it is heard going down, and is down from then until it is heard coming up', () => {
    const ok = okHeld();
    expect(ok.since()).toBeNull();

    ok.seen(key('enter', DOWN), BACK);
    expect(ok.since()).toBe(BACK);
    ok.seen(key('enter', UP), BACK + 120);
    expect(ok.since()).toBeNull();
  });

  it('counts from the first going down: a held key says "down" again and again', () => {
    const ok = okHeld();
    ok.seen(key('enter', DOWN), BACK);
    for (let i = 1; i <= 20; i += 1) ok.seen(key('enter', DOWN), BACK + i * 100);

    expect(ok.since()).toBe(BACK);
  });

  it('knows OK by both its names, and no other key', () => {
    const ok = okHeld();
    ok.seen(key('select', DOWN), BACK);
    ok.seen(key('enter', UP), BACK + 50);
    expect(ok.since()).toBeNull();

    for (const other of ['left', 'right', 'play', 'back', 'menu']) ok.seen(key(other, DOWN), BACK + 100);
    expect(ok.since()).toBeNull();
  });

  it('takes a press that arrives whole — no halves — as over', () => {
    const ok = okHeld();
    ok.seen(key('enter', DOWN), BACK);
    ok.seen(key('enter'), BACK + 500);

    expect(ok.since()).toBeNull();
  });

  it('forgets a key when Wick goes behind another app: where it comes up is not Wick’s to hear', () => {
    const ok = okHeld();
    ok.seen(key('enter', DOWN), BACK);

    ok.forget();

    expect(ok.since()).toBeNull();
  });

  it('is put right by the next key coming up, when one was never heard: at most one press is lost', () => {
    const ok = okHeld();
    ok.seen(key('enter', DOWN), BACK);
    // The key came up unheard. The next press: its going down looks like the old one still held…
    ok.seen(key('enter', DOWN), BACK + 60_000);
    expect(ok.since()).toBe(BACK);
    // …and its coming up puts it right.
    ok.seen(key('enter', UP), BACK + 60_100);
    expect(ok.since()).toBeNull();
  });
});
