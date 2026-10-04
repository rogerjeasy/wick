import { describe, expect, it } from 'vitest';
import { CIRCLE_ACTIONS, circleCardId } from '@wick/contracts';
import {
  circleDecision,
  membershipDecisionUpdate,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../circle.mjs';

describe('circleDecision — the resident’s press, read from the card id alone', () => {
  it('allows the person the card is about', () => {
    expect(circleDecision(circleCardId('u_sarah'), CIRCLE_ACTIONS.allow)).toEqual({ userId: 'u_sarah', status: 'allowed' });
  });

  it('declines them', () => {
    expect(circleDecision(circleCardId('u_sarah'), CIRCLE_ACTIONS.decline)).toEqual({ userId: 'u_sarah', status: 'declined' });
  });

  it('is nothing for any other card, or any other press', () => {
    expect(circleDecision('week-2026-W40', 'allow')).toBeUndefined();
    expect(circleDecision('note-123', 'allow')).toBeUndefined();
    expect(circleDecision(circleCardId('u_sarah'), 'seen')).toBeUndefined();
    expect(circleDecision('circle-', 'allow')).toBeUndefined();
  });
});

describe('membershipDecisionUpdate', () => {
  const update = membershipDecisionUpdate({ table: 'wick', householdId: 'hh_1', userId: 'u_sarah', status: 'allowed', at: 123 });

  it('records the answer and when it was given', () => {
    expect(update.Key).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: 'MEM#u_sarah' } });
    expect(update.ExpressionAttributeValues[':status']).toEqual({ S: 'allowed' });
    expect(update.ExpressionAttributeValues[':at']).toEqual({ N: '123' });
  });

  it('only answers a question that is still open: a replayed or stray press cannot change an answer already given', () => {
    expect(update.ConditionExpression).toBe('#status = :pending');
    expect(update.ExpressionAttributeValues[':pending']).toEqual({ S: 'pending' });
  });

  it('refuses a status the resident cannot give', () => {
    expect(() => membershipDecisionUpdate({ table: 'wick', householdId: 'hh_1', userId: 'u', status: 'removed', at: 1 })).toThrow();
  });
});
