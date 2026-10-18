import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSEHOLD_TIME_ZONE, isTimeZone, timeZoneOfMeta } from '../clock.js';

describe('isTimeZone', () => {
  it('takes the names Intl knows', () => {
    for (const zone of ['Europe/London', 'America/Los_Angeles', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'UTC', 'Etc/GMT+5']) {
      expect(isTimeZone(zone)).toBe(true);
    }
  });

  it('refuses anything else, without throwing', () => {
    for (const value of ['', 'Mars/Olympus_Mons', 'Europe/London; drop', '../etc', 'x'.repeat(65), 42, undefined, null, {}]) {
      expect(isTimeZone(value)).toBe(false);
    }
  });
});

describe('timeZoneOfMeta', () => {
  it("reads the household's own zone", () => {
    expect(timeZoneOfMeta({ timeZone: { S: 'America/Chicago' } })).toBe('America/Chicago');
  });

  it('reads a home given no zone, or a zone nobody knows, in the default', () => {
    expect(timeZoneOfMeta(undefined)).toBe(DEFAULT_HOUSEHOLD_TIME_ZONE);
    expect(timeZoneOfMeta({})).toBe(DEFAULT_HOUSEHOLD_TIME_ZONE);
    expect(timeZoneOfMeta({ timeZone: { S: 'Nowhere/Atall' } })).toBe(DEFAULT_HOUSEHOLD_TIME_ZONE);
  });
});

describe('the house clock', () => {
  it('reads a moment as the wall clock shows it where the house is', async () => {
    const { localWallClock } = await import('../clock.js');
    // 16:00 UTC on 14 October 2026 is 09:00 in Los Angeles (PDT) and 17:00 in London (BST).
    const at = Date.UTC(2026, 9, 14, 16);
    expect(localWallClock(at, 'America/Los_Angeles')).toBe(Date.UTC(2026, 9, 14, 9));
    expect(localWallClock(at, 'Europe/London')).toBe(Date.UTC(2026, 9, 14, 17));
  });

  it('turns a wall-clock time back into the moment, across a change of the clocks', async () => {
    const { fromLocalWallClock, localWallClock } = await import('../clock.js');
    for (const zone of ['America/Los_Angeles', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney']) {
      // Either side of the European and American clock changes of 2026.
      for (const wall of [Date.UTC(2026, 9, 24, 9), Date.UTC(2026, 9, 26, 9), Date.UTC(2026, 10, 2, 9), Date.UTC(2026, 2, 30, 9)]) {
        expect(localWallClock(fromLocalWallClock(wall, zone), zone)).toBe(wall);
      }
    }
  });

  it('finds the midnight of the day where the house is, not of the day in UTC', async () => {
    const { localDayStart } = await import('../clock.js');
    // 03:00 UTC on Thursday 15 October is still Wednesday evening in Los Angeles.
    const at = Date.UTC(2026, 9, 15, 3);
    expect(localDayStart(at, 'America/Los_Angeles')).toBe(Date.UTC(2026, 9, 14, 7));
    expect(localDayStart(at, 'Europe/London')).toBe(Date.UTC(2026, 9, 14, 23));
    expect(localDayStart(at, 'UTC')).toBe(Date.UTC(2026, 9, 15));
  });
});
