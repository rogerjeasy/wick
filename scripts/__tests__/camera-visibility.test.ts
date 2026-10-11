import { describe, expect, it } from 'vitest';
import { cameraVisibility } from '../camera-visibility.js';

const recorded = [
  { deviceId: 'ava1.ring.device.PLAYGROUND', householdId: 'margaret' },
  { deviceId: 'ava1.ring.device.KITCHEN', householdId: 'hh_2' },
];

describe('cameraVisibility', () => {
  it('finds a recorded camera the token cannot see — the state that made Watch live answer 404', () => {
    const { seen, unseen } = cameraVisibility(recorded, []);

    expect(seen).toEqual([]);
    expect(unseen.map((r) => r.deviceId)).toEqual(['ava1.ring.device.PLAYGROUND', 'ava1.ring.device.KITCHEN']);
  });

  it('separates the cameras it can see from the ones it cannot', () => {
    const { seen, unseen } = cameraVisibility(recorded, ['ava1.ring.device.PLAYGROUND', 'ava1.ring.device.UNASSIGNED']);

    expect(seen.map((r) => r.householdId)).toEqual(['margaret']);
    expect(unseen.map((r) => r.householdId)).toEqual(['hh_2']);
  });

  it('has nothing to report when no camera is recorded', () => {
    expect(cameraVisibility([], ['ava1.ring.device.PLAYGROUND'])).toEqual({ seen: [], unseen: [] });
  });
});
