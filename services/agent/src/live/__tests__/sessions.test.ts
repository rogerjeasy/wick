import { describe, it, expect, vi } from 'vitest';
import { liveSessions, type LiveDdbSend } from '../sessions.js';

const conditionFailed = () => Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
type Cmd = { readonly input: Record<string, unknown>; readonly constructor: { name: string } };
const inputOf = (send: ReturnType<typeof vi.fn>, i: number) => (send.mock.calls[i]![0] as Cmd).input;
const nameOf = (send: ReturnType<typeof vi.fn>, i: number) => (send.mock.calls[i]![0] as Cmd).constructor.name;

describe('liveSessions.claim — one live view per household', () => {
  it('claims LIVE#active for a fresh session when none is running', async () => {
    const send = vi.fn<LiveDdbSend>(async () => ({}));
    const out = await liveSessions(send, 'wick').claim('margaret', 'sess-new', 1_000, 61_000);

    expect(out).toEqual({ joined: false, sessionId: 'sess-new', endsAt: 61_000 });
    expect(inputOf(send, 0)).toEqual({
      TableName: 'wick',
      Item: {
        pk: { S: 'HH#margaret' }, sk: { S: 'LIVE#active' },
        sessionId: { S: 'sess-new' }, endsAt: { N: '61000' }, ttl: { N: String(Math.floor(61_000 / 1000) + 3600) },
      },
      ConditionExpression: 'attribute_not_exists(pk) OR endsAt < :now',
      ExpressionAttributeValues: { ':now': { N: '1000' } },
    });
  });

  it('joins the stream already running instead of starting a second', async () => {
    const send = vi.fn<LiveDdbSend>()
      .mockRejectedValueOnce(conditionFailed())
      .mockResolvedValueOnce({ Item: { sessionId: { S: 'sess-old' }, endsAt: { N: '50000' } } });

    expect(await liveSessions(send, 'wick').claim('margaret', 'sess-new', 1_000, 61_000))
      .toEqual({ joined: true, sessionId: 'sess-old', endsAt: 50_000 });
  });

  it('propagates any other failure', async () => {
    const send = vi.fn<LiveDdbSend>(async () => { throw new Error('throttled'); });
    await expect(liveSessions(send, 'wick').claim('margaret', 's', 1, 2)).rejects.toThrow('throttled');
  });
});

describe('liveSessions stop / release', () => {
  it('requestStop flags only the session it names', async () => {
    const send = vi.fn<LiveDdbSend>(async () => ({}));
    expect(await liveSessions(send, 'wick').requestStop('margaret', 'sess-1')).toBe(true);
    expect(nameOf(send, 0)).toBe('UpdateItemCommand');
    expect(inputOf(send, 0)).toMatchObject({
      Key: { pk: { S: 'HH#margaret' }, sk: { S: 'LIVE#active' } },
      UpdateExpression: 'SET stopRequested = :t',
      ConditionExpression: 'sessionId = :id',
    });
  });

  it('requestStop is false for a session that is not the running one', async () => {
    const send = vi.fn<LiveDdbSend>(async () => { throw conditionFailed(); });
    expect(await liveSessions(send, 'wick').requestStop('margaret', 'other')).toBe(false);
  });

  it('isStopRequested reads the flag for that session only', async () => {
    const flagged = vi.fn<LiveDdbSend>(async () => ({ Item: { sessionId: { S: 's1' }, stopRequested: { BOOL: true } } }));
    expect(await liveSessions(flagged, 'wick').isStopRequested('margaret', 's1')).toBe(true);
    expect(await liveSessions(flagged, 'wick').isStopRequested('margaret', 's2')).toBe(true);
    const clear = vi.fn<LiveDdbSend>(async () => ({ Item: { sessionId: { S: 's1' } } }));
    expect(await liveSessions(clear, 'wick').isStopRequested('margaret', 's1')).toBe(false);
  });

  it('release deletes LIVE#active only while it still belongs to that session', async () => {
    const send = vi.fn<LiveDdbSend>(async () => ({}));
    await liveSessions(send, 'wick').release('margaret', 'sess-1');
    expect(nameOf(send, 0)).toBe('DeleteItemCommand');
    expect(inputOf(send, 0)).toMatchObject({ ConditionExpression: 'sessionId = :id', ExpressionAttributeValues: { ':id': { S: 'sess-1' } } });

    const gone = vi.fn<LiveDdbSend>(async () => { throw conditionFailed(); });
    await expect(liveSessions(gone, 'wick').release('margaret', 'sess-1')).resolves.toBeUndefined();
  });
});
