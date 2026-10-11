import { describe, it, expect, vi } from 'vitest';
import type { RingDevice } from '@wick/ring';
import { devicesOfHousehold, ringDeviceOwners, type DdbSend } from '../ringDevices.js';

describe('ringDeviceOwners.householdOf', () => {
  it('reads RINGDEV#<deviceId> and answers with the household that holds it', async () => {
    const send = vi.fn<DdbSend>(async () => ({ Item: { householdId: { S: 'margaret' } } }));

    expect(await ringDeviceOwners(send, 'wick').householdOf('ava1.ring.device.ABNJQ')).toBe('margaret');
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'RINGDEV#ava1.ring.device.ABNJQ' }, sk: { S: 'META' } },
      ConsistentRead: true,
    });
  });

  it('is undefined for a doorbell no household holds', async () => {
    expect(await ringDeviceOwners(vi.fn<DdbSend>(async () => ({})), 'wick').householdOf('unheld')).toBeUndefined();
  });
});

describe('ringDeviceOwners.assign', () => {
  it('files the device under the household, unless another household already holds it', async () => {
    const send = vi.fn<DdbSend>(async () => ({}));

    expect(await ringDeviceOwners(send, 'wick', () => 1_700_000_000_000).assign('cam-1', 'margaret')).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Item: { pk: { S: 'RINGDEV#cam-1' }, sk: { S: 'META' }, householdId: { S: 'margaret' }, assignedAt: { N: '1700000000000' } },
      ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
      ExpressionAttributeValues: { ':hh': { S: 'margaret' } },
    });
  });

  it('is false when another household holds the device: its rings and pictures stay where they are', async () => {
    const send = vi.fn<DdbSend>(async () => {
      throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    });
    expect(await ringDeviceOwners(send, 'wick').assign('cam-1', 'hh-other')).toBe(false);
  });

  it('propagates any other failure', async () => {
    const send = vi.fn<DdbSend>(async () => { throw new Error('throttled'); });
    await expect(ringDeviceOwners(send, 'wick').assign('cam-1', 'margaret')).rejects.toThrow('throttled');
  });
});

describe('devicesOfHousehold', () => {
  const ringDevice = (id: string): RingDevice => ({ id, name: id, online: true, capabilities: { motion: false, image: false, chime: true } });

  it('keeps only the devices that household holds, on a Ring account several households share', async () => {
    const holders: Record<string, string> = { 'chime-a': 'hh-a', 'chime-b': 'hh-b' };
    const devices = [ringDevice('chime-a'), ringDevice('chime-b'), ringDevice('chime-unheld')];

    const mine = await devicesOfHousehold('hh-b', devices, async (deviceId) => holders[deviceId]);

    expect(mine.map((d) => d.id)).toEqual(['chime-b']);
  });
});
