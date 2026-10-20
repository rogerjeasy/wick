import { describe, expect, it } from 'vitest';
import { HOUR_MS, doorUnheard, heardAround, heardHoursOf, heardSk, lastHeard } from '../heard.js';

const DAY = 86_400_000;
const MIDNIGHT = Date.UTC(2026, 9, 9);
const hourly = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let h = from; h < to; h += HOUR_MS) out.push(h);
  return out;
};

describe('the doorbell heard', () => {
  it('files a moment under its UTC day and hour, and reads the hours back as their starts', () => {
    expect(heardSk(MIDNIGHT + 9.5 * HOUR_MS)).toBe('HEARD#2026-10-09');
    expect(heardHoursOf('HEARD#2026-10-09', ['13', '9', '24', 'x'])).toEqual([MIDNIGHT + 9 * HOUR_MS, MIDNIGHT + 13 * HOUR_MS]);
    expect(heardHoursOf('EVT#000', ['9'])).toEqual([]);
  });

  it('says a stretch was heard around only when the doorbell was heard before it and after it', () => {
    const from = MIDNIGHT + 8.5 * HOUR_MS;
    const to = MIDNIGHT + 9.5 * HOUR_MS;
    const now = MIDNIGHT + 14 * HOUR_MS;
    expect(heardAround(hourly(MIDNIGHT - DAY, now), from, to, now)).toBe(true);
    // Heard before, then nothing: the doorbell went down.
    expect(heardAround(hourly(MIDNIGHT - DAY, MIDNIGHT + 5 * HOUR_MS), from, to, now)).toBe(false);
    // Nothing before, then heard again only afterwards.
    expect(heardAround(hourly(MIDNIGHT + 13 * HOUR_MS, now), from, to, now)).toBe(false);
    // One car at seven and one at eleven are enough: the doorbell was alive on both sides.
    expect(heardAround([MIDNIGHT + 7 * HOUR_MS, MIDNIGHT + 11 * HOUR_MS], from, to, now)).toBe(true);
  });

  it('says the doorbell is unheard after six hours without a word, and when it was last heard', () => {
    const now = MIDNIGHT + 14 * HOUR_MS;
    expect(doorUnheard(hourly(MIDNIGHT, MIDNIGHT + 12 * HOUR_MS), now)).toBe(false);
    expect(doorUnheard(hourly(MIDNIGHT, MIDNIGHT + 7 * HOUR_MS), now)).toBe(true);
    expect(lastHeard(hourly(MIDNIGHT, MIDNIGHT + 7 * HOUR_MS), now)).toBe(MIDNIGHT + 7 * HOUR_MS);
    expect(doorUnheard([], now)).toBe(true);
    expect(lastHeard([], now)).toBeUndefined();
  });
});
