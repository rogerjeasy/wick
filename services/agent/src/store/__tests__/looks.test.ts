import { describe, it, expect, vi } from 'vitest';
import { lookStore, type LookSend } from '../looks.js';

const request = { householdId: 'margaret', cardId: 'door-abc', askedAt: 1_000_000, expiresAt: 1_270_000 };

describe('lookStore.claimOnce', () => {
  it('writes LOOK#<cardId> only if nobody has asked about that card yet', async () => {
    const send = vi.fn<LookSend>(async () => ({}));

    expect(await lookStore(send, 'wick').claimOnce(request)).toBe(true);

    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: 'wick',
      Item: { pk: { S: 'HH#margaret' }, sk: { S: 'LOOK#door-abc' }, askedAt: { N: '1000000' }, expiresAt: { N: '1270000' } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('is false when the question was already asked — the second press', async () => {
    const send = vi.fn<LookSend>(async () => {
      throw Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    });

    expect(await lookStore(send, 'wick').claimOnce(request)).toBe(false);
  });

  it('lets any other failure through: a press that was not filed must not be reported as asked', async () => {
    const send = vi.fn<LookSend>(async () => {
      throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    });

    await expect(lookStore(send, 'wick').claimOnce(request)).rejects.toThrow('throttled');
  });
});

describe('lookStore.listFamily', () => {
  it('reads the circle as it stands now — a consistent read — and keeps only the people allowed', async () => {
    const send = vi.fn<LookSend>(async () => ({
      Items: [
        { sk: { S: 'MEM#u-sarah' }, name: { S: 'Sarah' }, status: { S: 'allowed' } },
        { sk: { S: 'MEM#u-tom' }, name: { S: 'Tom' }, status: { S: 'removed' } },
      ],
    }));

    expect(await lookStore(send, 'wick').listFamily('margaret')).toEqual([{ userId: 'u-sarah', name: 'Sarah' }]);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: 'wick',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: 'HH#margaret' }, ':prefix': { S: 'MEM#' } },
      ConsistentRead: true,
    });
  });
});
