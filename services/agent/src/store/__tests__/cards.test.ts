import { describe, it, expect, vi } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { cardStore, type DdbSend } from '../cards.js';

const queued = { id: 'door-abc', urgency: 'DOOR', queuedAt: 1, shownCount: 0, card: { type: 'DOOR', id: 'door-abc' } } as unknown as QueuedCard;

describe('cardStore.loadCard', () => {
  it('reads the CARD# item for that household and parses its data', async () => {
    const send = vi.fn<DdbSend>(async () => ({ Item: { data: { S: JSON.stringify(queued) } } }));
    const store = cardStore(send, 'wick');

    expect(await store.loadCard('margaret', 'door-abc')).toEqual(queued);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: 'wick',
      Key: { pk: { S: 'HH#margaret' }, sk: { S: 'CARD#door-abc' } },
      ConsistentRead: true,
    });
  });

  it('is undefined for a card that is not there (aged out by TTL, or never sent)', async () => {
    const store = cardStore(vi.fn<DdbSend>(async () => ({})), 'wick');
    expect(await store.loadCard('margaret', 'nope')).toBeUndefined();
  });
});

describe('cardStore.claimOnce', () => {
  it('writes CHIME#<cardId> only if it does not exist, expiring after a day', async () => {
    const send = vi.fn<DdbSend>(async () => ({}));
    const store = cardStore(send, 'wick', () => 1_000_000);

    expect(await store.claimOnce('margaret', 'door-abc')).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Item: { pk: { S: 'HH#margaret' }, sk: { S: 'CHIME#door-abc' }, ttl: { N: String(1000 + 86_400) } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('is false when the card was already claimed — the second press', async () => {
    const send = vi.fn<DdbSend>(async () => {
      throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
    });
    expect(await cardStore(send, 'wick').claimOnce('margaret', 'door-abc')).toBe(false);
  });

  it('propagates any other failure — an unknown claim state must not ring', async () => {
    const send = vi.fn<DdbSend>(async () => { throw new Error('throttled'); });
    await expect(cardStore(send, 'wick').claimOnce('margaret', 'door-abc')).rejects.toThrow('throttled');
  });
});

describe('cardStore.loadLiveTarget', () => {
  it('returns the card with the Ring camera stored beside it', async () => {
    const send = vi.fn<DdbSend>(async () => ({ Item: { data: { S: JSON.stringify(queued) }, ringDeviceId: { S: 'cam-1' } } }));
    expect(await cardStore(send, 'wick').loadLiveTarget('margaret', 'door-abc')).toEqual({ queued, ringDeviceId: 'cam-1' });
  });

  it('returns the card without a camera for a card written before cameras were recorded', async () => {
    const send = vi.fn<DdbSend>(async () => ({ Item: { data: { S: JSON.stringify(queued) } } }));
    expect(await cardStore(send, 'wick').loadLiveTarget('margaret', 'door-abc')).toEqual({ queued });
  });

  it('is undefined when there is no card', async () => {
    expect(await cardStore(vi.fn<DdbSend>(async () => ({})), 'wick').loadLiveTarget('margaret', 'x')).toBeUndefined();
  });
});
