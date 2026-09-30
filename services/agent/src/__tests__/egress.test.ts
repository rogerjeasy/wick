import { describe, it, expect } from 'vitest';
import type { DoorCard, DayCard } from '@wick/contracts';
import { applyCardPatch, liveDeviceConnections } from '../egress.js';

const door: DoorCard = {
  type: 'DOOR',
  id: 'door-1',
  householdId: 'hh-1',
  correlationId: 'corr-1',
  createdAt: 1,
  line: "Someone's at the front door.",
  actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }],
};

describe('applyCardPatch', () => {
  it('merges the image ref onto the stored door card', () => {
    const patched = applyCardPatch(door, { cardId: 'door-1', imageRef: 'https://example/x.jpg' });
    expect(patched).toMatchObject({ imageRef: 'https://example/x.jpg', line: door.line });
  });

  it('merges the description onto the stored door card', () => {
    const patched = applyCardPatch(door, { cardId: 'door-1', description: 'A man holding a parcel.' });
    expect(patched).toMatchObject({ description: 'A man holding a parcel.' });
  });

  it('leaves fields the patch does not carry untouched', () => {
    const withImage = applyCardPatch(door, { cardId: 'door-1', imageRef: 'https://example/x.jpg' });
    const withDescriptionToo = applyCardPatch(withImage, { cardId: 'door-1', description: 'A man holding a parcel.' });
    expect(withDescriptionToo).toMatchObject({
      imageRef: 'https://example/x.jpg',
      description: 'A man holding a parcel.',
    });
  });

  it('is a no-op for a non-DOOR card — patches only ever target the door card (Phase 2, §5.2)', () => {
    const day: DayCard = {
      type: 'DAY',
      id: 'day-1',
      householdId: 'hh-1',
      correlationId: 'corr-1',
      createdAt: 1,
      greeting: 'A few things from today.',
      actions: [],
      items: [],
    };
    expect(applyCardPatch(day, { cardId: 'day-1', description: 'nope' })).toBe(day);
  });

  it('is a no-op when the patch names a different card — a stale/misrouted patch must not overwrite the wrong card', () => {
    expect(applyCardPatch(door, { cardId: 'door-other', imageRef: 'https://example/x.jpg' })).toBe(door);
  });
});

describe('liveDeviceConnections', () => {
  const WS = 'https://ws.example/prod';
  const dev = (id: string, conn?: string) => ({
    pk: { S: 'HH#margaret' },
    sk: { S: `DEV#${id}` },
    ...(conn ? { connectionId: { S: conn }, transport: { S: 'websocket' }, wsEndpoint: { S: WS } } : {}),
  });

  it('finds the connected TV even when a disconnected device sorts before it', () => {
    // The exact household state that swallowed a live door card on the VVD:
    // DynamoDB returns DEV# keys in sort order, and 'ops-console-…' and
    // 'sim-tv-…' both sort before 'wick-tv'.
    const items = [dev('ops-console-1789772257830'), dev('sim-tv-1789747594'), dev('wick-tv', 'conn-1')];

    expect(liveDeviceConnections(items)).toEqual([{ connectionId: 'conn-1', wsEndpoint: WS, deviceSk: 'DEV#wick-tv' }]);
  });

  it('returns every connected TV in the household — a door card belongs on all of them', () => {
    const items = [dev('bedroom', 'conn-2'), dev('living-room', 'conn-1')];

    expect(liveDeviceConnections(items).map((c) => c.connectionId)).toEqual(['conn-2', 'conn-1']);
  });

  it('skips a device on the MQTT path — IoT Core publish is not wired up yet', () => {
    const mqtt = { ...dev('wick-tv', 'conn-1'), transport: { S: 'mqtt' } };

    expect(liveDeviceConnections([mqtt])).toEqual([]);
  });

  it('returns nothing when no device is connected — reconcile delivers on next connect', () => {
    expect(liveDeviceConnections([dev('wick-tv')])).toEqual([]);
  });
});
