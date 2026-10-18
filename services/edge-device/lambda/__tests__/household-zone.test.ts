import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSEHOLD_TIME_ZONE as CONTRACT_DEFAULT, HOUSEHOLD_TIME_ZONE_ATTR as CONTRACT_ATTR } from '@wick/contracts';
import { DEFAULT_HOUSEHOLD_TIME_ZONE, HOUSEHOLD_TIME_ZONE_ATTR, isTimeZone, timeZoneOfRows } from '../household-zone.mjs';

describe('household-zone.mjs', () => {
  it('keeps the contract: the same attribute and the same default', () => {
    expect(HOUSEHOLD_TIME_ZONE_ATTR).toBe(CONTRACT_ATTR);
    expect(DEFAULT_HOUSEHOLD_TIME_ZONE).toBe(CONTRACT_DEFAULT);
  });

  it("reads the zone from the household's own row among the home rows", () => {
    const rows = [
      { pk: { S: 'HH#hh_1' }, sk: { S: 'LIGHT' } },
      { pk: { S: 'HH#hh_1' }, sk: { S: 'META' }, timeZone: { S: 'America/Los_Angeles' } },
    ];
    expect(timeZoneOfRows(rows)).toBe('America/Los_Angeles');
  });

  it('reads a home with no zone, or none it knows, in the default', () => {
    expect(timeZoneOfRows([{ sk: { S: 'META' } }])).toBe('Europe/London');
    expect(timeZoneOfRows([{ sk: { S: 'META' }, timeZone: { S: 'Not/AZone' } }])).toBe('Europe/London');
    expect(timeZoneOfRows(undefined)).toBe('Europe/London');
  });

  it('refuses what is not a zone without throwing', () => {
    expect(isTimeZone('Asia/Tokyo')).toBe(true);
    expect(isTimeZone('Europe/London; x')).toBe(false);
    expect(isTimeZone(7)).toBe(false);
  });
});
