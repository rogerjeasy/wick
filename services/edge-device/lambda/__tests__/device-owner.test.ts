import { describe, expect, it } from 'vitest';
import {
  claimDeviceOwner,
  deviceOwnerKey,
  householdOfDevice,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../device-owner.mjs';

describe('a television belongs to one household', () => {
  it('records the household under the device, so a refresh needs only the device id', () => {
    expect(deviceOwnerKey('tv-1')).toEqual({ pk: { S: 'DEV#tv-1' }, sk: { S: 'META' } });
  });

  it('claims a television nobody has, or one this household already has', () => {
    const put = claimDeviceOwner({ table: 'wick', deviceId: 'tv-1', householdId: 'hh_1', at: 9 });

    expect(put.Item).toEqual({ pk: { S: 'DEV#tv-1' }, sk: { S: 'META' }, householdId: { S: 'hh_1' }, claimedAt: { N: '9' } });
    // Without this, pairing a television in one home would silently hand another home's television over.
    expect(put.ConditionExpression).toBe('attribute_not_exists(pk) OR householdId = :hh');
    expect(put.ExpressionAttributeValues).toEqual({ ':hh': { S: 'hh_1' } });
  });

  it('reads the household back', () => {
    expect(householdOfDevice({ householdId: { S: 'hh_1' } })).toBe('hh_1');
    expect(householdOfDevice(undefined)).toBeUndefined();
  });
});
