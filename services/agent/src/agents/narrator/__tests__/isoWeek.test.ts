import { describe, it, expect } from 'vitest';
import { currentIsoWeek } from '@wick/contracts';
import { isoWeekRange } from '../isoWeek.js';

describe('isoWeekRange', () => {
  it('is the inverse of currentIsoWeek — Monday 00:00 UTC to the following Monday, exclusive', () => {
    const { startMs, endMs } = isoWeekRange('2026-W38');
    expect(new Date(startMs).toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('round-trips with currentIsoWeek for a date in the middle of the week', () => {
    const at = Date.UTC(2026, 8, 15, 9, 10); // Tuesday
    const week = currentIsoWeek(new Date(at));
    const { startMs, endMs } = isoWeekRange(week);
    expect(at).toBeGreaterThanOrEqual(startMs);
    expect(at).toBeLessThan(endMs);
  });

  it('handles the year-end rollover — week 1 starts in the previous December', () => {
    const { startMs, endMs } = isoWeekRange('2026-W01');
    expect(new Date(startMs).toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-01-05T00:00:00.000Z');
  });

  it('handles a 53-week year rolling into the next January', () => {
    const { startMs, endMs } = isoWeekRange('2026-W53');
    expect(new Date(startMs).toISOString()).toBe('2026-12-28T00:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2027-01-04T00:00:00.000Z');
  });

  it('throws on a malformed week string rather than silently computing a wrong range', () => {
    expect(() => isoWeekRange('not-a-week')).toThrow();
    expect(() => isoWeekRange('2026-38')).toThrow();
  });
});
