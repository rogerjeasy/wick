import { describe, expect, it, vi } from 'vitest';
import { tellStore, type TellSend } from '../tells.js';

const row = { householdId: 'hh-1', differenceId: 'missed_visit-maria-2026-10-09', kind: 'missed_visit', factClass: 'PRESENCE', sentence: 'Maria usually comes on Friday mornings. There was no visit on Friday.', at: 1, askedAt: 2_000_000, weeksObserved: 6 } as const;
const failing = (name: string) => vi.fn<TellSend>(async () => { throw Object.assign(new Error(name), { name }); });

describe('tellStore.claimOnce', () => {
  it('writes TELL#<differenceId> only if that difference has never been asked about', async () => {
    const send = vi.fn<TellSend>(async () => ({}));

    expect(await tellStore(send, 'wick').claimOnce(row)).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: 'wick',
      Item: { pk: { S: 'HH#hh-1' }, sk: { S: 'TELL#missed_visit-maria-2026-10-09' }, sentence: { S: row.sentence } },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('is false when it was asked before, and lets any other failure through', async () => {
    expect(await tellStore(failing('ConditionalCheckFailedException'), 'wick').claimOnce(row)).toBe(false);
    await expect(tellStore(failing('ThrottlingException'), 'wick').claimOnce(row)).rejects.toThrow('ThrottlingException');
  });
});

describe('tellStore.recordAnswer', () => {
  it('writes the answer onto a question that is still open, and only then', async () => {
    const send = vi.fn<TellSend>(async () => ({}));

    expect(await tellStore(send, 'wick').recordAnswer('hh-1', 'missed_visit-maria-2026-10-09', 'tell', 5_000)).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'TELL#missed_visit-maria-2026-10-09' } },
      UpdateExpression: 'SET answer = :answer, answeredAt = :at',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answer)',
      ExpressionAttributeValues: { ':answer': { S: 'tell' }, ':at': { N: '5000' } },
    });
  });

  it('is false for a question already answered, or never asked: a television cannot open one by pressing', async () => {
    expect(await tellStore(failing('ConditionalCheckFailedException'), 'wick').recordAnswer('hh-1', 'x', 'tell', 1)).toBe(false);
  });
});

describe('tellStore.release', () => {
  it('takes back a question that was filed but never shown — never one that has been answered', async () => {
    const send = vi.fn<TellSend>(async () => ({}));

    await tellStore(send, 'wick').release('hh-1', 'missed_visit-maria-2026-10-09');

    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: 'TELL#missed_visit-maria-2026-10-09' } },
      ConditionExpression: 'attribute_not_exists(answer)',
    });
  });

  it('is quiet when there was nothing to take back', async () => {
    await expect(tellStore(failing('ConditionalCheckFailedException'), 'wick').release('hh-1', 'x')).resolves.toBeUndefined();
  });
});
