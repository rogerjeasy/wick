import { describe, expect, it } from 'vitest';
import { localDayCode, localMinuteOfDay } from '../clock.js';

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
