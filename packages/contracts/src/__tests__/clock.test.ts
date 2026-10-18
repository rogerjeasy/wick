import { describe, expect, it } from 'vitest';
import { localDayCode, localMinuteOfDay, saidOnHerClock } from '../clock.js';

const LONDON = 'Europe/London';

describe('the day and the time where the house is', () => {
  it('reads a moment on the household clock, not in UTC', () => {
    // Tuesday 13 October 2026, 08:59 UTC is 09:59 in London (summer time).
    const at = Date.UTC(2026, 9, 13, 8, 59);
    expect(localDayCode(at, LONDON)).toBe('TUE');
    expect(localMinuteOfDay(at, LONDON)).toBe(9 * 60 + 59);
  });

  it('follows the clocks back: after 25 October nine in London is nine in UTC', () => {
    const at = Date.UTC(2026, 9, 27, 9, 0); // Tuesday 27 October, GMT
    expect(localDayCode(at, LONDON)).toBe('TUE');
    expect(localMinuteOfDay(at, LONDON)).toBe(9 * 60);
  });

  it('takes the day across midnight with the time', () => {
    // 23:30 UTC on Monday 12 October is 00:30 on Tuesday in London.
    const at = Date.UTC(2026, 9, 12, 23, 30);
    expect(localDayCode(at, LONDON)).toBe('TUE');
    expect(localMinuteOfDay(at, LONDON)).toBe(30);
  });

  it('reads midnight as minute zero', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 9, 12, 23, 0), LONDON)).toBe(0);
  });
});

describe('saidOnHerClock — a note\'s time as she says it', () => {
  it('says a time that can only be 24-hour on a 12-hour clock', () => {
    expect(saidOnHerClock("I'll come round on Saturday at 14:00. Shall I bring the cake?")).toBe("I'll come round on Saturday at 2 pm. Shall I bring the cake?");
    expect(saidOnHerClock('Dinner at 19:30')).toBe('Dinner at 7:30 pm');
    expect(saidOnHerClock('The nurse comes at 08:15.')).toBe('The nurse comes at 8:15 am.');
    expect(saidOnHerClock('Back by 00:00')).toBe('Back by midnight');
    expect(saidOnHerClock('Ring at 00:30')).toBe('Ring at 12:30 am');
  });

  it('leaves a time that could be either, a time already marked, and everything else as written', () => {
    for (const note of ['See you at 7:30', 'Lunch at 12:15', 'At 2 pm', 'At 14:00 pm', 'At 2:30PM', 'Tea at 3', 'It costs £2.50', 'Score was 10:3'])
      expect(saidOnHerClock(note), note).toBe(note);
  });
});
