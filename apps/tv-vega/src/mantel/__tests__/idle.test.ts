import { describe, expect, it, vi } from 'vitest';
import { MANTEL_EACH_FOR_MS, MANTEL_IDLE_AFTER_MS, type MantelItem } from '@wick/contracts';
import { HOLD_MS, okHold } from '../../watch/hold.js';
import {
  IDLE_KEY_GUARD_MS,
  IDLE_OFF,
  IDLE_OK_GUARD_MS,
  blocksHome,
  homeIsQuiet,
  idleDue,
  idleOnBack,
  idleOnKey,
  idleOnLook,
  idlePicture,
  idleShows,
  lookAtIdle,
  type HomeNow,
  type Idle,
} from '../idle.js';

const NOW = 1_800_000_000_000;
const DOWN = 0;
const UP = 1;
const key = (eventType: string, eventKeyAction?: number) => ({ eventType, ...(eventKeyAction === undefined ? {} : { eventKeyAction }) });
const item = (photoId: string, fromName = 'Sarah'): MantelItem => ({ photoId, fromName, keptAt: 5, url: `https://pictures.example/${photoId}.jpg` });

/** The home screen, with nothing on it but the films, and pictures on her mantelpiece. */
const QUIET: HomeNow = { foreground: true, watching: false, mantelOpen: false, liveOpen: false, cardShowing: false, waiting: false, home: { light: 'on', mantel: 3 } };
const ON: Idle = { phase: 'on', startedAt: NOW };

describe('homeIsQuiet — when her pictures may fill the screen at all', () => {
  it('is the home screen in front, with no card, nothing playing, nothing waiting — and something on her mantelpiece', () => {
    expect(homeIsQuiet(QUIET)).toBe(true);
  });

  it('is not while a card is showing: the idle screen makes nothing disappear', () => {
    expect(homeIsQuiet({ ...QUIET, cardShowing: true })).toBe(false);
  });

  it('is not while something waits on the home screen that is hers to answer', () => {
    expect(homeIsQuiet({ ...QUIET, waiting: true })).toBe(false);
  });

  it('is not while a film is on screen, playing or paused, nor the door camera, nor the mantelpiece itself', () => {
    expect(homeIsQuiet({ ...QUIET, watching: true })).toBe(false);
    expect(homeIsQuiet({ ...QUIET, liveOpen: true })).toBe(false);
    expect(homeIsQuiet({ ...QUIET, mantelOpen: true })).toBe(false);
  });

  it('is not while another app is in front', () => {
    expect(homeIsQuiet({ ...QUIET, foreground: false })).toBe(false);
  });

  it('is not when she has kept nothing: there is nothing to show', () => {
    expect(homeIsQuiet({ ...QUIET, home: { light: 'on' } })).toBe(false);
    expect(homeIsQuiet({ ...QUIET, home: {} })).toBe(false);
  });
});

describe('idleDue — after the home screen has sat untouched', () => {
  it('is due once no key has been pressed for the contract’s three minutes, and not a moment before', () => {
    expect(MANTEL_IDLE_AFTER_MS).toBe(3 * 60_000);
    expect(idleDue({ ...QUIET, lastActiveAt: NOW, now: NOW + MANTEL_IDLE_AFTER_MS - 1 })).toBe(false);
    expect(idleDue({ ...QUIET, lastActiveAt: NOW, now: NOW + MANTEL_IDLE_AFTER_MS })).toBe(true);
  });

  it('is never due while the home screen is not quiet, however long it has been', () => {
    const long = { lastActiveAt: NOW, now: NOW + 10 * MANTEL_IDLE_AFTER_MS };

    expect(idleDue({ ...QUIET, ...long, cardShowing: true })).toBe(false);
    expect(idleDue({ ...QUIET, ...long, watching: true })).toBe(false);
    expect(idleDue({ ...QUIET, ...long, waiting: true })).toBe(false);
    expect(idleDue({ ...QUIET, ...long, foreground: false })).toBe(false);
    expect(idleDue({ ...QUIET, ...long, home: {} })).toBe(false);
  });
});

describe('idleOnLook — the one-second look turns it on, and off', () => {
  it('comes on when it is due and there are pictures to show', () => {
    expect(idleOnLook(IDLE_OFF, { due: true, pictures: 3, now: NOW })).toEqual({ phase: 'on', startedAt: NOW });
  });

  it('does not come on with nothing to show — the answer has not come, or every address failed', () => {
    expect(idleOnLook(IDLE_OFF, { due: true, pictures: 0, now: NOW })).toBe(IDLE_OFF);
    expect(idleOnLook(IDLE_OFF, { due: false, pictures: 3, now: NOW })).toBe(IDLE_OFF);
  });

  it('stays on, from when it began, while nothing changes', () => {
    expect(idleOnLook(ON, { due: true, pictures: 3, now: NOW + 60_000 })).toBe(ON);
  });

  it('ends at once when a card becomes showable, a film starts or Wick leaves the screen: nothing is delayed', () => {
    expect(idleOnLook(ON, { due: false, pictures: 3, now: NOW + 60_000 })).toBe(IDLE_OFF);
  });

  it('ends when there is no longer anything to show', () => {
    expect(idleOnLook(ON, { due: true, pictures: 0, now: NOW + 60_000 })).toBe(IDLE_OFF);
  });
});

describe('idlePicture — one at a time, slowly', () => {
  const items = [item('p1'), item('p2'), item('p3')];

  it('shows each for the contract’s twenty seconds, in order, and round again', () => {
    expect(MANTEL_EACH_FOR_MS).toBe(20_000);
    expect(idlePicture(items, NOW, NOW)?.photoId).toBe('p1');
    expect(idlePicture(items, NOW, NOW + MANTEL_EACH_FOR_MS - 1)?.photoId).toBe('p1');
    expect(idlePicture(items, NOW, NOW + MANTEL_EACH_FOR_MS)?.photoId).toBe('p2');
    expect(idlePicture(items, NOW, NOW + 2 * MANTEL_EACH_FOR_MS)?.photoId).toBe('p3');
    expect(idlePicture(items, NOW, NOW + 3 * MANTEL_EACH_FOR_MS)?.photoId).toBe('p1');
  });

  it('shows the one picture she has, and nothing when she has none', () => {
    expect(idlePicture([item('p1')], NOW, NOW + 5 * MANTEL_EACH_FOR_MS)?.photoId).toBe('p1');
    expect(idlePicture([], NOW, NOW)).toBeUndefined();
  });

  it('is not thrown by a clock that goes backwards', () => {
    expect(idlePicture(items, NOW, NOW - 5_000)?.photoId).toBe('p1');
  });
});

describe('idleShows — which pictures the idle screen may use', () => {
  const mantel = { items: [item('p1'), item('p2')], receivedAt: NOW };

  it('uses what the server answered, while its addresses are good', () => {
    expect(idleShows(mantel, [], NOW + 60_000).map((i) => i.photoId)).toEqual(['p1', 'p2']);
  });

  it('leaves out a picture whose address did not answer: the idle screen has no words to say so', () => {
    expect(idleShows(mantel, ['p1'], NOW + 60_000).map((i) => i.photoId)).toEqual(['p2']);
    expect(idleShows(mantel, ['p1', 'p2'], NOW + 60_000)).toEqual([]);
  });

  it('uses nothing it has not been told, and nothing whose addresses have run out', () => {
    expect(idleShows(undefined, [], NOW)).toEqual([]);
    expect(idleShows(mantel, [], NOW + 60 * 60_000)).toEqual([]);
  });
});

describe('idleOnKey — any key ends it, and that press does nothing else', () => {
  it('takes no notice of keys while it is off: the home screen is hers', () => {
    expect(idleOnKey(IDLE_OFF, key('enter', DOWN), NOW)).toBe(IDLE_OFF);
    expect(blocksHome(IDLE_OFF)).toBe(false);
  });

  it('keeps the home screen out of reach for as long as it is on', () => {
    expect(blocksHome(ON)).toBe(true);
  });

  it('ends on OK going down — and keeps the home screen out of reach until OK has come up: the film under her thumb must not start', () => {
    const ending = idleOnKey(ON, key('enter', DOWN), NOW + 1_000);

    expect(ending).toEqual({ phase: 'ending', key: 'enter', at: NOW + 1_000 });
    expect(blocksHome(ending)).toBe(true);
    expect(idleOnKey(ending, key('enter', UP), NOW + 1_150)).toBe(IDLE_OFF);
  });

  it('ends the same way on every key there is', () => {
    for (const name of ['select', 'enter', 'left', 'right', 'up', 'down', 'play', 'playpause', 'forward', 'rewind', 'menu', 'something_new']) {
      const ending = idleOnKey(ON, key(name, DOWN), NOW);
      expect(ending, name).toEqual({ phase: 'ending', key: name, at: NOW });
      expect(idleOnKey(ending, key(name, UP), NOW + 100), name).toBe(IDLE_OFF);
    }
  });

  it('is not ended twice by a key that repeats while it is held', () => {
    let idle = idleOnKey(ON, key('right', DOWN), NOW);
    for (let i = 1; i <= 5; i += 1) idle = idleOnKey(idle, key('right', DOWN), NOW + i * 100);

    expect(idle).toEqual({ phase: 'ending', key: 'right', at: NOW });
    expect(idleOnKey(idle, key('right', UP), NOW + 700)).toBe(IDLE_OFF);
  });

  it('treats the two names OK goes by as one key', () => {
    expect(idleOnKey(idleOnKey(ON, key('select', DOWN), NOW), key('enter', UP), NOW + 100)).toBe(IDLE_OFF);
  });

  it('does not let go for another key coming up', () => {
    const ending = idleOnKey(ON, key('enter', DOWN), NOW);

    expect(idleOnKey(ending, key('left', UP), NOW + 50)).toBe(ending);
  });

  it('takes a second key pressed meanwhile as consumed too: the first must be up, and this one was pressed at a screen she could not see', () => {
    const second = idleOnKey(idleOnKey(ON, key('right', DOWN), NOW), key('enter', DOWN), NOW + 300);

    expect(second).toEqual({ phase: 'ending', key: 'enter', at: NOW + 300 });
    expect(blocksHome(second)).toBe(true);
    expect(idleOnKey(second, key('enter', UP), NOW + 400)).toBe(IDLE_OFF);
  });

  it('ends at once on a press that arrives whole — a key coming up with no going down, or an event with neither', () => {
    expect(idleOnKey(ON, key('enter', UP), NOW)).toBe(IDLE_OFF);
    expect(idleOnKey(ON, key('enter'), NOW)).toBe(IDLE_OFF);
    expect(idleOnKey(idleOnKey(ON, key('left', DOWN), NOW), key('enter'), NOW + 50)).toBe(IDLE_OFF);
  });

  it('gives up waiting for a key that never says it came up — soon for an arrow, later for OK, whose coming up could press something', () => {
    const arrow = idleOnKey(ON, key('right', DOWN), NOW);
    expect(idleOnLook(arrow, { due: false, pictures: 3, now: NOW + IDLE_KEY_GUARD_MS - 1 })).toBe(arrow);
    expect(idleOnLook(arrow, { due: false, pictures: 3, now: NOW + IDLE_KEY_GUARD_MS })).toBe(IDLE_OFF);

    const ok = idleOnKey(ON, key('select', DOWN), NOW);
    expect(idleOnLook(ok, { due: false, pictures: 3, now: NOW + IDLE_KEY_GUARD_MS })).toBe(ok);
    expect(idleOnLook(ok, { due: false, pictures: 3, now: NOW + IDLE_OK_GUARD_MS })).toBe(IDLE_OFF);
    expect(IDLE_OK_GUARD_MS).toBeGreaterThan(HOLD_MS);
  });

  it('does not come back on while a key is still being let go, however long the screen had been idle', () => {
    const ending = idleOnKey(ON, key('enter', DOWN), NOW);

    expect(idleOnLook(ending, { due: true, pictures: 3, now: NOW + 500 })).toBe(ending);
  });
});

describe('idleOnBack — Back ends it too, and does not leave Wick', () => {
  it('ends it and is consumed', () => {
    expect(idleOnBack(ON)).toEqual({ idle: IDLE_OFF, consumed: true });
    expect(idleOnBack(idleOnKey(ON, key('back', DOWN), NOW))).toEqual({ idle: IDLE_OFF, consumed: true });
  });

  it('is nothing to do with it when it is off: Back is the home screen’s', () => {
    expect(idleOnBack(IDLE_OFF)).toEqual({ idle: IDLE_OFF, consumed: false });
  });
});

describe('the idle screen and holding OK for Sarah (watch/hold.ts, home/HomeScreen.tsx)', () => {
  it('ends on a held OK without it being a hold: the press is consumed whole, however long it lasts', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    let idle: Idle = ON;
    // The home screen's hold is the focused tile's own long press, and no tile can be focused while the home
    // screen is out of reach. Were the keys timed instead, as over a film, they would be timed only then.
    const hold = okHold({ onHold, canHold: () => !blocksHome(idle) });
    const press = (event: { eventType: string; eventKeyAction?: number }) => {
      hold.onEvent(event);
      idle = idleOnKey(idle, event, Date.now());
    };

    press(key('enter', DOWN));
    vi.advanceTimersByTime(HOLD_MS + 500);
    expect(blocksHome(idle)).toBe(true);
    press(key('enter', UP));

    expect(idle).toBe(IDLE_OFF);
    expect(onHold).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('leaves the next hold as it was: once the home screen is back, two seconds on OK is a hold again', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    let idle: Idle = ON;
    const hold = okHold({ onHold, canHold: () => !blocksHome(idle) });
    const press = (event: { eventType: string; eventKeyAction?: number }) => {
      hold.onEvent(event);
      idle = idleOnKey(idle, event, Date.now());
    };
    press(key('enter', DOWN));
    press(key('enter', UP));
    expect(idle).toBe(IDLE_OFF);

    press(key('enter', DOWN));
    vi.advanceTimersByTime(HOLD_MS);
    press(key('enter', UP));

    expect(onHold).toHaveBeenCalledTimes(1);
    expect(idle).toBe(IDLE_OFF);
    vi.useRealTimers();
  });

  it('only listens: every key reaches the hold detector exactly as it came, on or off', () => {
    const seen: unknown[] = [];
    const events = [key('enter', DOWN), key('enter', DOWN), key('enter', UP), key('left', DOWN), key('left', UP)];
    let idle: Idle = IDLE_OFF;
    for (const event of events) {
      const before = JSON.stringify(event);
      idle = idleOnKey(idle, event, NOW);
      expect(JSON.stringify(event)).toBe(before);
      seen.push(event);
    }

    expect(seen).toEqual(events);
    expect(idle).toBe(IDLE_OFF);
  });
});

describe('lookAtIdle — the whole of what the one-second look decides for the idle screen', () => {
  const mantel = { items: [item('p1'), item('p2')], receivedAt: NOW };
  const at = { ...QUIET, now: NOW + MANTEL_IDLE_AFTER_MS, idle: IDLE_OFF, lastActiveAt: NOW, mantel, askedAt: null, failed: [] as string[] };

  it('puts her pictures up when the home screen has been quiet for the few minutes, starting with the first', () => {
    expect(lookAtIdle(at)).toEqual({ idle: { phase: 'on', startedAt: at.now }, lastActiveAt: NOW, ask: false, picture: item('p1') });
  });

  it('counts the idle minutes from now for as long as the home screen is not quiet', () => {
    const busy = lookAtIdle({ ...at, cardShowing: true });

    expect(busy).toEqual({ idle: IDLE_OFF, lastActiveAt: at.now, ask: false, picture: undefined });
    // So when the card has gone, the minutes start again.
    expect(lookAtIdle({ ...at, now: at.now + 1_000, lastActiveAt: busy.lastActiveAt }).idle).toBe(IDLE_OFF);
    expect(lookAtIdle({ ...at, mantel: { ...mantel, receivedAt: at.now }, now: at.now + MANTEL_IDLE_AFTER_MS, lastActiveAt: busy.lastActiveAt }).idle.phase).toBe('on');
  });

  it('asks for her pictures when it is due and has none, and waits for them with the home screen as it is', () => {
    expect(lookAtIdle({ ...at, mantel: undefined })).toEqual({ idle: IDLE_OFF, lastActiveAt: NOW, ask: true, picture: undefined });
    expect(lookAtIdle({ ...at, mantel: undefined, askedAt: at.now - 1_000 }).ask).toBe(false);
  });

  it('does not ask before it is due: what is on her mantelpiece is asked for only when it is about to be shown', () => {
    expect(lookAtIdle({ ...at, now: NOW + 60_000, mantel: undefined }).ask).toBe(false);
    expect(lookAtIdle({ ...at, cardShowing: true, mantel: undefined }).ask).toBe(false);
  });

  it('asks while she has the mantelpiece open and what it has is old — and never puts the idle screen over it', () => {
    const open = lookAtIdle({ ...at, mantelOpen: true, mantel: undefined });

    expect(open.ask).toBe(true);
    expect(open.idle).toBe(IDLE_OFF);
  });

  it('leaves out a picture that did not load, and comes down when none is left', () => {
    const on: Idle = { phase: 'on', startedAt: NOW };

    expect(lookAtIdle({ ...at, idle: on, failed: ['p1'] }).picture).toEqual(item('p2'));
    expect(lookAtIdle({ ...at, idle: on, failed: ['p1', 'p2'] })).toMatchObject({ idle: IDLE_OFF, picture: undefined });
  });

  it('has no picture up while a key is still ending it', () => {
    const ending: Idle = { phase: 'ending', key: 'enter', at: at.now };

    expect(lookAtIdle({ ...at, idle: ending, now: at.now + 500 })).toMatchObject({ idle: ending, picture: undefined });
  });
});
