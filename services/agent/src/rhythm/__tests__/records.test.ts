import { describe, it, expect } from 'vitest';
import { dowHourBucket, buildDoorActivityKey, buildPresenceKey, buildTvActivityKey } from '../records.js';

describe('dowHourBucket', () => {
  it('buckets a UTC timestamp into a 3-letter day-of-week and a 2-digit hour, per WICK-TECHNICAL §8.2', () => {
    // 2026-09-15 is a Tuesday. 06:51 UTC.
    expect(dowHourBucket(1789455093305)).toBe('TUE-06');
  });

  it('pads a single-digit hour', () => {
    // 2026-09-13 is a Sunday, 03:00:00.000 UTC.
    expect(dowHourBucket(Date.UTC(2026, 8, 13, 3, 0, 0))).toBe('SUN-03');
  });
});

describe('buildDoorActivityKey', () => {
  it('keys the bucket under the household, dimensioned by device, sub-type and measure — §8.2\'s door_activity table', () => {
    const key = buildDoorActivityKey({
      householdId: 'hh-1',
      deviceId: 'ava1.ring.device.ABNJQ',
      subType: 'human',
      measureName: 'motion',
      at: 1789455093305,
    });

    expect(key.pk).toBe('HH#hh-1');
    expect(key.sk).toBe('RHYTHM#door_activity#ava1.ring.device.ABNJQ#human#motion#TUE-06');
  });
});

describe('buildPresenceKey', () => {
  it('keys the bucket under the household, dimensioned by person and measure — §8.2\'s presence table', () => {
    const key = buildPresenceKey({
      householdId: 'hh-1',
      personId: 'maria',
      measureName: 'arrival',
      at: 1789455093305,
    });

    expect(key.pk).toBe('HH#hh-1');
    expect(key.sk).toBe('RHYTHM#presence#maria#arrival#TUE-06');
  });
});

describe('buildTvActivityKey', () => {
  it('keys the bucket under the household, dimensioned by device and measure — §8.2\'s tv_activity table', () => {
    const key = buildTvActivityKey({
      householdId: 'hh-1',
      deviceId: 'tv-1',
      measureName: 'foreground',
      at: 1789455093305,
    });

    expect(key.pk).toBe('HH#hh-1');
    expect(key.sk).toBe('RHYTHM#tv_activity#tv-1#foreground#TUE-06');
  });
});
