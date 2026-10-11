import { describe, it, expect } from 'vitest';
import type { DoorCard, MessageCard } from '@wick/contracts';
import { applyCardPatch, cardItem, liveDeviceConnections } from '../egress.js';

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
    const note: MessageCard = {
      type: 'MESSAGE',
      id: 'note-1',
      householdId: 'hh-1',
      correlationId: 'corr-1',
      createdAt: 1,
      fromName: 'Sarah',
      actions: [],
      suggestedReplies: [],
    };
    expect(applyCardPatch(note, { cardId: 'note-1', description: 'nope' })).toBe(note);
  });

  it('is a no-op when the patch names a different card — a stale/misrouted patch must not overwrite the wrong card', () => {
    expect(applyCardPatch(door, { cardId: 'door-other', imageRef: 'https://example/x.jpg' })).toBe(door);
  });
});

describe('applyCardPatch — M1 feedback', () => {
  it('merges a notice and replaces the actions', () => {
    const patched = applyCardPatch(door, {
      cardId: 'door-1',
      notice: 'The hallway chime rang.',
      actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }],
    });
    expect(patched.type === 'DOOR' && patched.notice).toBe('The hallway chime rang.');
    expect(patched.actions.map((a) => a.id)).toEqual(['dismiss']);
  });

  it('never lets a patch carry more than three actions onto the card', () => {
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'secondary' as const }));
    expect(applyCardPatch(door, { cardId: 'door-1', actions: four }).actions).toHaveLength(3);
  });
});

describe('applyCardPatch — headline correction', () => {
  it('merges a corrected line onto the stored door card', () => {
    const patched = applyCardPatch(door, { cardId: 'door-1', line: 'Movement at the front door.' });
    expect(patched).toMatchObject({ line: 'Movement at the front door.' });
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

  it('falls back to the card service when Wick is not on screen, and says so', () => {
    const behind = { ...dev('wick-tv'), bgConnectionId: { S: 'bg-1' }, bgTransport: { S: 'websocket' }, bgWsEndpoint: { S: WS } };

    expect(liveDeviceConnections([behind])).toEqual([{ connectionId: 'bg-1', wsEndpoint: WS, deviceSk: 'DEV#wick-tv', background: true }]);
  });

  it('sends to the app alone when it is on screen — the card will be seen, so no toast as well', () => {
    const both = { ...dev('wick-tv', 'conn-1'), bgConnectionId: { S: 'bg-1' }, bgTransport: { S: 'websocket' }, bgWsEndpoint: { S: WS } };

    expect(liveDeviceConnections([both])).toEqual([{ connectionId: 'conn-1', wsEndpoint: WS, deviceSk: 'DEV#wick-tv' }]);
  });

  it('chooses per television: one with Wick on screen, one with another app in front', () => {
    const bedroom = { ...dev('bedroom'), bgConnectionId: { S: 'bg-2' }, bgTransport: { S: 'websocket' }, bgWsEndpoint: { S: WS } };
    const items = [bedroom, dev('living-room', 'conn-1')];

    expect(liveDeviceConnections(items).map((c) => [c.connectionId, c.background ?? false])).toEqual([['bg-2', true], ['conn-1', false]]);
  });

  it('skips a device on the MQTT path — IoT Core publish is not wired up yet', () => {
    const mqtt = { ...dev('wick-tv', 'conn-1'), transport: { S: 'mqtt' } };

    expect(liveDeviceConnections([mqtt])).toEqual([]);
  });

  it('returns nothing when no device is connected — reconcile delivers on next connect', () => {
    expect(liveDeviceConnections([dev('wick-tv')])).toEqual([]);
  });
});

describe('cardItem — the CARD# queue item', () => {
  const queued = { id: 'door-1', urgency: 'DOOR' as const, card: door, queuedAt: 1, expiresAt: 300_000, shownCount: 0 };

  it('stores the card as data, with a DynamoDB ttl from expiresAt', () => {
    const item = cardItem(queued);
    expect(item.pk).toEqual({ S: 'HH#hh-1' });
    expect(item.sk).toEqual({ S: 'CARD#door-1' });
    expect(JSON.parse(item.data!.S!)).toEqual(queued);
    expect(item.ttl).toEqual({ N: '300' });
  });

  it('keeps the Ring camera id beside the card, outside the data the device is sent', () => {
    const item = cardItem(queued, { ringDeviceId: 'ava1.ring.device.ABNJQ' });
    expect(item.ringDeviceId).toEqual({ S: 'ava1.ring.device.ABNJQ' });
    expect(item.data!.S).not.toContain('ava1.ring.device.ABNJQ');
  });
});
