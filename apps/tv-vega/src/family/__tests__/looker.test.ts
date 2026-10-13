import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_TV_LOOK_EVERY_MS, type FamilyTvHome } from '@wick/contracts';
import type { HomeAnswer } from '../familyClient.js';
import { FamilyLooker, type LookState } from '../looker.js';

const HOME: FamilyTvHome = { residentName: 'Margaret', memberName: 'Sarah', cards: [] };
const home = (extra: Partial<FamilyTvHome> = {}): HomeAnswer => ({ kind: 'home', home: { ...HOME, ...extra } });
const FAILED: HomeAnswer = { kind: 'failed' };

/** A server whose answers the test hands over one at a time, or lets hang. */
function harness(everyMs?: number) {
  const states: LookState[] = [];
  const pending: Array<(answer: HomeAnswer) => void> = [];
  const queued: HomeAnswer[] = [];
  const look = vi.fn(
    () =>
      new Promise<HomeAnswer>((resolve) => {
        const ready = queued.shift();
        if (ready) resolve(ready);
        else pending.push(resolve);
      }),
  );
  const looker = new FamilyLooker({ look, onChange: (state) => states.push(state), ...(everyMs ? { everyMs } : {}) });
  return {
    looker,
    look,
    states,
    /** Answers that will be given at once, in order, to the looks that come. */
    willAnswer: (...answers: HomeAnswer[]) => void queued.push(...answers),
    /** Answers the oldest look still waiting. */
    answer: async (answer: HomeAnswer) => {
      pending.shift()!(answer);
      await vi.advanceTimersByTimeAsync(0);
    },
    last: () => states[states.length - 1],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FamilyLooker — when a family television asks again', () => {
  it('looks as soon as it starts, and shows nothing of a home before it has one', async () => {
    const h = harness();
    expect(h.looker.state).toEqual({ kind: 'starting', unreachable: false });

    h.looker.start();
    expect(h.look).toHaveBeenCalledTimes(1);

    await h.answer(home());
    expect(h.last()).toEqual({ kind: 'home', home: HOME, unreachable: false });
  });

  it('looks again every FAMILY_TV_LOOK_EVERY_MS, and not before', async () => {
    const h = harness();
    h.willAnswer(home(), home(), home());
    h.looker.start();

    await vi.advanceTimersByTimeAsync(FAMILY_TV_LOOK_EVERY_MS - 1);
    expect(h.look).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.look).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FAMILY_TV_LOOK_EVERY_MS);
    expect(h.look).toHaveBeenCalledTimes(3);
  });

  it('never has two looks out at once: one still waiting is not asked over', async () => {
    const h = harness(1000);
    h.looker.start();

    await vi.advanceTimersByTimeAsync(3500);
    expect(h.look).toHaveBeenCalledTimes(1);

    await h.answer(home());
    await vi.advanceTimersByTimeAsync(500);
    expect(h.look).toHaveBeenCalledTimes(2);
  });

  it('says only what changed: the same home twice is announced once', async () => {
    const h = harness(1000);
    h.willAnswer(home(), home(), home({ cards: [{ id: 'c', kind: 'reach', headline: 'h', actions: [] }] }));
    h.looker.start();

    await vi.advanceTimersByTimeAsync(2000);

    expect(h.look).toHaveBeenCalledTimes(3);
    expect(h.states.map((s) => (s.kind === 'home' ? s.home.cards.length : s.kind))).toEqual([0, 1]);
  });
});

describe('FamilyLooker — a look that fails', () => {
  it('keeps the last good home on screen and tries again at the next interval', async () => {
    const h = harness(1000);
    h.willAnswer(home(), FAILED, home({ memberName: 'Tom' }));
    h.looker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.looker.state).toEqual({ kind: 'home', home: HOME, unreachable: false });

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.looker.state).toEqual({ kind: 'home', home: { ...HOME, memberName: 'Tom' }, unreachable: false });
  });

  it('says it cannot reach the home after three failures in a row — and keeps trying', async () => {
    const h = harness(1000);
    h.willAnswer(home(), FAILED, FAILED);
    h.looker.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.looker.state).toEqual({ kind: 'home', home: HOME, unreachable: false });

    h.willAnswer(FAILED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last()).toEqual({ kind: 'home', home: HOME, unreachable: true });

    h.willAnswer(FAILED, home());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.look).toHaveBeenCalledTimes(6);
    expect(h.last()).toEqual({ kind: 'home', home: HOME, unreachable: false });
  });

  it('counts failures in a row only: a good look in between starts the count again', async () => {
    const h = harness(1000);
    h.willAnswer(home(), FAILED, FAILED, home(), FAILED, FAILED);
    h.looker.start();

    await vi.advanceTimersByTimeAsync(5000);

    expect(h.look).toHaveBeenCalledTimes(6);
    expect(h.states.every((s) => s.kind !== 'home' || !s.unreachable)).toBe(true);
  });

  it('says so with no home at all when it has never reached one', async () => {
    const h = harness(1000);
    h.willAnswer(FAILED, FAILED, FAILED);
    h.looker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.looker.state).toEqual({ kind: 'starting', unreachable: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last()).toEqual({ kind: 'starting', unreachable: true });
  });
});

describe('FamilyLooker — off screen and back', () => {
  it('does not look while the app is off screen', async () => {
    const h = harness(1000);
    h.willAnswer(home());
    h.looker.start();
    await vi.advanceTimersByTimeAsync(0);

    h.looker.setOnScreen(false);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.look).toHaveBeenCalledTimes(1);
  });

  it('looks at once on the way back, and then at the interval counted from there', async () => {
    const h = harness(1000);
    h.willAnswer(home(), home(), home());
    h.looker.start();
    await vi.advanceTimersByTimeAsync(300);
    h.looker.setOnScreen(false);
    await vi.advanceTimersByTimeAsync(5000);

    h.looker.setOnScreen(true);
    expect(h.look).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(h.look).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.look).toHaveBeenCalledTimes(3);
  });

  it('is not started by coming on screen, and being told twice it is on screen is one look', async () => {
    const h = harness(1000);
    h.looker.setOnScreen(true);
    expect(h.look).not.toHaveBeenCalled();

    h.willAnswer(home());
    h.looker.start();
    h.looker.setOnScreen(true);
    expect(h.look).toHaveBeenCalledTimes(1);
  });

  it('waits for the screen when it is started off screen', async () => {
    const h = harness(1000);
    h.looker.setOnScreen(false);
    h.looker.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.look).not.toHaveBeenCalled();

    h.looker.setOnScreen(true);
    expect(h.look).toHaveBeenCalledTimes(1);
  });
});

describe('FamilyLooker — what the server says besides a home', () => {
  it('is signed out on a 401 the client could not mend, and never looks again', async () => {
    const h = harness(1000);
    h.willAnswer(home(), { kind: 'signedOut' });
    h.looker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last()).toEqual({ kind: 'signedOut' });

    await vi.advanceTimersByTimeAsync(10_000);
    h.looker.setOnScreen(false);
    h.looker.setOnScreen(true);
    await h.looker.lookNow();
    expect(h.look).toHaveBeenCalledTimes(2);
  });

  it('shows the sentence and nothing of the home when the resident has not allowed this member — and keeps asking', async () => {
    const h = harness(1000);
    h.willAnswer(home(), { kind: 'notAllowed', say: 'Margaret has not said yes yet.' });
    h.looker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last()).toEqual({ kind: 'notAllowed', say: 'Margaret has not said yes yet.' });

    h.willAnswer(home());
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.last()).toEqual({ kind: 'home', home: HOME, unreachable: false });
  });

  it('goes on showing only that sentence however many looks fail after it', async () => {
    const h = harness(1000);
    h.willAnswer({ kind: 'notAllowed', say: 'Not yet.' }, FAILED, FAILED, FAILED, FAILED);
    h.looker.start();

    await vi.advanceTimersByTimeAsync(4000);

    expect(h.look).toHaveBeenCalledTimes(5);
    expect(h.states).toEqual([{ kind: 'notAllowed', say: 'Not yet.' }]);
  });

  it('takes "not allowed" and "signed out" from a press as it would from a look', async () => {
    const h = harness(1000);
    h.willAnswer(home());
    h.looker.start();
    await vi.advanceTimersByTimeAsync(0);

    h.looker.heard({ kind: 'notAllowed', say: 'Margaret no longer shares this.' });
    expect(h.last()).toEqual({ kind: 'notAllowed', say: 'Margaret no longer shares this.' });

    h.looker.heard({ kind: 'signedOut' });
    expect(h.last()).toEqual({ kind: 'signedOut' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.look).toHaveBeenCalledTimes(1);
  });
});

describe('FamilyLooker — looking now, and stopping', () => {
  it('looks at once when asked to, after a press', async () => {
    const h = harness(1000);
    h.willAnswer(home(), home({ memberName: 'Tom' }));
    h.looker.start();
    await vi.advanceTimersByTimeAsync(100);

    await h.looker.lookNow();

    expect(h.look).toHaveBeenCalledTimes(2);
    expect(h.looker.state).toEqual({ kind: 'home', home: { ...HOME, memberName: 'Tom' }, unreachable: false });
  });

  it('asks once more after a look already out, which may have been answered before the press', async () => {
    const h = harness(1000);
    h.looker.start();
    expect(h.look).toHaveBeenCalledTimes(1);

    const looked = h.looker.lookNow();
    expect(h.look).toHaveBeenCalledTimes(1);

    await h.answer(home());
    expect(h.look).toHaveBeenCalledTimes(2);
    await h.answer(home({ memberName: 'Tom' }));
    await looked;

    expect(h.looker.state).toEqual({ kind: 'home', home: { ...HOME, memberName: 'Tom' }, unreachable: false });
  });

  it('stops: no more looks, and an answer still on its way changes nothing', async () => {
    const h = harness(1000);
    h.looker.start();
    h.looker.stop();

    await h.answer(home());
    await vi.advanceTimersByTimeAsync(5000);

    expect(h.look).toHaveBeenCalledTimes(1);
    expect(h.states).toEqual([]);
  });
});
