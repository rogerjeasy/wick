/**
 * The home screen takes no press in its first second back within the
 * remote's reach (apps/tv-vega/src/press/settle.ts `pressActs`,
 * home/HomeScreen.tsx) — found here, on the emulator: a second OK 317 ms
 * after the one that answered a note started the film underneath.
 *
 * What differs on Fire OS is the shape a press arrives in (FRICTION.md
 * FL-028): a short OK reaches JavaScript only as the key coming up, and a
 * held one as `longSelect`. The rule compares when a press is SEEN with
 * when the home came back, so the shape must not matter — and a hold must
 * still be a hold. Both are run here on keys as this app's adapter says
 * them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteKeyEvents } from '../adapters/remoteEvents.js';
import { PRESS_SETTLE_MS, pressActs } from '../../../tv-vega/src/press/settle.js';
import { HOLD_MS, isOkKey, okHold } from '../../../tv-vega/src/watch/hold.js';

const BACK_AT = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BACK_AT);
});
afterEach(() => {
  vi.useRealTimers();
});

/** The home's focused film, as far as OK goes: a press when the key comes up, unless it was a hold. */
function film() {
  const toKeys = remoteKeyEvents();
  const tile = { started: 0, swallowed: 0, holds: 0 };
  const hold = okHold({ onHold: () => (tile.holds += 1), canHold: () => true });
  return {
    tile,
    /** One Android key event, at the time the clock says. */
    android(eventType: string, eventKeyAction: number) {
      for (const key of toKeys({ eventType, eventKeyAction })) {
        const wasHold = hold.held();
        hold.onEvent(key);
        // OK coming up is the press — the only half a short press has here. No other key presses anything.
        if (!isOkKey(key.eventType) || key.eventKeyAction !== 1 || wasHold) continue;
        if (pressActs(BACK_AT, Date.now())) tile.started += 1;
        else tile.swallowed += 1;
      }
    },
  };
}

describe('the home’s first second, on keys as Fire OS delivers them', () => {
  it('a short OK — the key coming up, and nothing else — seen 317 ms after the home came back starts no film', () => {
    const { tile, android } = film();

    vi.advanceTimersByTime(317);
    android('select', 1);

    expect(tile).toEqual({ started: 0, swallowed: 1, holds: 0 });
  });

  it('the same press 1.1 seconds after starts it', () => {
    const { tile, android } = film();

    vi.advanceTimersByTime(317);
    android('select', 1);
    vi.advanceTimersByTime(783);
    android('select', 1);

    expect(tile).toEqual({ started: 1, swallowed: 1, holds: 0 });
  });

  it('a held OK — longSelect, down and then up — begun at 300 ms is still the hold, and is not a press when it is let go', () => {
    const { tile, android } = film();

    vi.advanceTimersByTime(300);
    android('longSelect', 0);
    vi.advanceTimersByTime(HOLD_MS + 200);
    android('longSelect', 1);

    expect(tile).toEqual({ started: 0, swallowed: 0, holds: 1 });
    expect(HOLD_MS).toBeGreaterThan(PRESS_SETTLE_MS);
  });

  it('the D-pad is no press at all: an arrow in that second is neither swallowed nor started', () => {
    const { tile, android } = film();

    vi.advanceTimersByTime(200);
    android('right', 0);
    android('right', 1);

    // The arrow moves the focus, which nothing here holds back.
    expect(tile).toEqual({ started: 0, swallowed: 0, holds: 0 });
  });
});
