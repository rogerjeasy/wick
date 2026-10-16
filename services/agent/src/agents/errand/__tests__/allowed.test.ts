import { describe, expect, it, vi } from 'vitest';
import { memberAllowed, type AllowedSend } from '../allowed.js';

describe('memberAllowed — the circle, asked again at every step (INV-9)', () => {
  it('reads the member’s own MEM# row, consistently, and is true only for one the resident allowed', async () => {
    const send = vi.fn<AllowedSend>(async () => ({ Item: { status: { S: 'allowed' } } }));

    expect(await memberAllowed(send, 'wick')('hh-1', 'u_sarah')).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'MEM#u_sarah' } },
      ProjectionExpression: '#s',
      ExpressionAttributeNames: { '#s': 'status' },
      ConsistentRead: true,
    });
  });

  it('is false for a membership waiting, removed or declined — and for none at all', async () => {
    for (const item of [{ status: { S: 'pending' } }, { status: { S: 'removed' } }, { status: { S: 'declined' } }, undefined]) {
      expect(await memberAllowed(async () => ({ Item: item }), 'wick')('hh-1', 'u_sarah')).toBe(false);
    }
  });
});
