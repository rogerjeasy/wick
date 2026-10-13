import { describe, expect, it } from 'vitest';
import { LIGHT_ACTIONS, LIGHT_CARD_ID, LIGHT_SK, LOOKIN_SK_PREFIX, endOfLocalDay, isLit, lookedInToday, lookedInWords, readHomeState, sameLocalDay } from '../light.js';

const LONDON = 'Europe/London';
/** Monday 12 October 2026, 08:30 in London (BST). */
const MORNING = Date.UTC(2026, 9, 12, 7, 30);
const HOUR = 3_600_000;

describe('sameLocalDay — a day as the household means it', () => {
  it('is the same day from just after midnight to just before the next, where the house is', () => {
    const justAfterMidnight = Date.UTC(2026, 9, 11, 23, 5); // 00:05 BST on the 12th
    const lateEvening = Date.UTC(2026, 9, 12, 22, 50); // 23:50 BST on the 12th

    expect(sameLocalDay(justAfterMidnight, lateEvening, LONDON)).toBe(true);
    expect(sameLocalDay(justAfterMidnight - 10 * 60_000, lateEvening, LONDON)).toBe(false);
  });
});

describe('endOfLocalDay — when today is over, where the house is', () => {
  it('is the first moment of the next day there', () => {
    // 08:30 BST on Monday the 12th: the day ends at midnight BST, 23:00 UTC.
    const midnight = Date.UTC(2026, 9, 12, 23, 0);

    expect(endOfLocalDay(MORNING, LONDON)).toBe(midnight);
    expect(sameLocalDay(midnight - 1, MORNING, LONDON)).toBe(true);
    expect(sameLocalDay(midnight, MORNING, LONDON)).toBe(false);
    // Asked a minute before midnight, it is that same midnight; asked at it, the next one.
    expect(endOfLocalDay(midnight - 60_000, LONDON)).toBe(midnight);
    expect(endOfLocalDay(midnight, LONDON)).toBe(midnight + 24 * HOUR);
  });

  it('is right on the days the clocks change, which are not twenty-four hours long', () => {
    // Sunday 25 October 2026: the clocks go back, and the day is twenty-five hours.
    expect(endOfLocalDay(Date.UTC(2026, 9, 24, 23, 30), LONDON)).toBe(Date.UTC(2026, 9, 26, 0, 0));
    expect(endOfLocalDay(Date.UTC(2026, 9, 25, 12, 0), LONDON)).toBe(Date.UTC(2026, 9, 26, 0, 0));
    // Sunday 29 March 2026: they go forward, and the day is twenty-three.
    expect(endOfLocalDay(Date.UTC(2026, 2, 29, 0, 30), LONDON)).toBe(Date.UTC(2026, 2, 29, 23, 0));
  });

  it('goes by the household’s clock', () => {
    // 08:30 in London is 03:30 in New York, where the day has twenty and a half hours to run.
    expect(endOfLocalDay(MORNING, 'America/New_York')).toBe(Date.UTC(2026, 9, 13, 4, 0));
  });
});

describe('readHomeState — a home screen’s state that has crossed the bus', () => {
  const look = { name: 'Sarah', at: MORNING, line: 'Sarah looked in this morning.' };

  it('keeps what is well formed', () => {
    expect(readHomeState({ light: 'on' })).toEqual({ light: 'on' });
    expect(readHomeState({ light: 'out', lightOutUntil: MORNING + HOUR, lookedIn: look })).toEqual({ light: 'out', lightOutUntil: MORNING + HOUR, lookedIn: look });
    // Nothing to say is still a state: nobody can see a light any more.
    expect(readHomeState({})).toEqual({});
  });

  it('drops what is not, and anything it does not know', () => {
    expect(readHomeState({ light: 'bright', lightOutUntil: 'soon', lookedIn: { name: 'Sarah' }, programme: 'sintel' })).toEqual({});
    expect(readHomeState({ light: 'on', lookedIn: { ...look, watching: 'sintel' } })).toEqual({ light: 'on', lookedIn: look });
  });

  it('is nothing at all when it is not a state', () => {
    expect(readHomeState(undefined)).toBeUndefined();
    expect(readHomeState('on')).toBeUndefined();
    expect(readHomeState(null)).toBeUndefined();
  });
});

describe('isLit — the light in the window', () => {
  it('is lit once a television in the home has been in use today', () => {
    expect(isLit({ activeAts: [MORNING], now: MORNING + HOUR, timeZone: LONDON })).toBe(true);
    expect(isLit({ activeAts: [MORNING - 24 * HOUR, MORNING], now: MORNING + HOUR, timeZone: LONDON })).toBe(true);
  });

  it('is not lit before the day has begun there: yesterday evening is not today', () => {
    expect(isLit({ activeAts: [], now: MORNING, timeZone: LONDON })).toBe(false);
    expect(isLit({ activeAts: [MORNING - 12 * HOUR], now: MORNING, timeZone: LONDON })).toBe(false);
  });

  it('is out for the rest of the day she put it out, and lit again the next', () => {
    const putOut = MORNING + HOUR;

    expect(isLit({ activeAts: [MORNING], outAt: putOut, now: putOut + 5 * HOUR, timeZone: LONDON })).toBe(false);
    // She watches something that evening: still out. It was her choice for the day.
    expect(isLit({ activeAts: [MORNING, putOut + 9 * HOUR], outAt: putOut, now: putOut + 10 * HOUR, timeZone: LONDON })).toBe(false);
    expect(isLit({ activeAts: [MORNING + 24 * HOUR], outAt: putOut, now: MORNING + 25 * HOUR, timeZone: LONDON })).toBe(true);
  });
});

describe('lookedInToday — who looked in', () => {
  const looks = [
    { name: 'Sarah', at: MORNING },
    { name: 'Tom', at: MORNING + 2 * HOUR },
    { name: 'Anna', at: MORNING - 20 * HOUR },
  ];

  it('is the latest look of today, where the house is', () => {
    expect(lookedInToday(looks, MORNING + 3 * HOUR, LONDON)).toEqual({ name: 'Tom', at: MORNING + 2 * HOUR });
  });

  it('is nobody when the only looks were on another day', () => {
    expect(lookedInToday([looks[2]!], MORNING, LONDON)).toBeUndefined();
    expect(lookedInToday([], MORNING, LONDON)).toBeUndefined();
  });
});

describe('the names both sides use', () => {
  it('keeps the light and the looks on rows of their own, and one card', () => {
    expect(LIGHT_SK).toBe('LIGHT');
    expect(LOOKIN_SK_PREFIX).toBe('LOOKIN#');
    expect(LIGHT_CARD_ID).toBe('light');
    expect(LIGHT_ACTIONS).toEqual({ putOut: 'put_out', lightAgain: 'light_again', ok: 'ok' });
  });
});

describe('lookedInWords — the sentence her home screen shows', () => {
  const at = (hour: number, minute = 0) => Date.UTC(2026, 9, 12, hour - 1, minute); // London is UTC+1

  it('names the person and the part of the day, where the house is', () => {
    expect(lookedInWords('Sarah', at(8, 15), LONDON)).toBe('Sarah looked in this morning.');
    expect(lookedInWords('Tom', at(12), LONDON)).toBe('Tom looked in this afternoon.');
    expect(lookedInWords('Tom', at(17, 59), LONDON)).toBe('Tom looked in this afternoon.');
    expect(lookedInWords('Anna', at(18), LONDON)).toBe('Anna looked in this evening.');
  });

  it('goes by the household’s clock, not the server’s', () => {
    // 11:30 UTC is half past twelve in London in October.
    expect(lookedInWords('Sarah', Date.UTC(2026, 9, 12, 11, 30), LONDON)).toBe('Sarah looked in this afternoon.');
  });
});
