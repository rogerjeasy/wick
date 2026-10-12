import { describe, expect, it } from 'vitest';
import { LIGHT_ACTIONS, LIGHT_CARD_ID, LIGHT_SK, LOOKIN_SK_PREFIX, isLit, lookedInToday, lookedInWords, sameLocalDay } from '../light.js';

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
