import { describe, expect, it } from 'vitest';
import {
  markCardActed,
  isReplayable,
  retiresCard,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../card-acted.mjs';

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  pk: { S: 'HH#margaret' },
  sk: { S: `CARD#${id}` },
  data: { S: JSON.stringify({ id }) },
  ...extra,
});

describe('markCardActed — a resident action retires the card server-side', () => {
  it('stamps actedAt on the CARD# item for that household', () => {
    const input = markCardActed({ table: 'wick', householdId: 'margaret', cardId: 'c1', at: 1_700 });

    expect(input.TableName).toBe('wick');
    expect(input.Key).toEqual({ pk: { S: 'HH#margaret' }, sk: { S: 'CARD#c1' } });
    expect(input.UpdateExpression).toBe('SET actedAt = if_not_exists(actedAt, :at)');
    expect(input.ExpressionAttributeValues).toEqual({ ':at': { N: '1700' } });
  });

  it('never creates a CARD# item for an id the server never sent (e.g. an on-device spike card)', () => {
    const input = markCardActed({ table: 'wick', householdId: 'margaret', cardId: 'sp1-spike-card', at: 1 });

    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
  });
});

describe('isReplayable — what reconcile may push back to a reconnecting device', () => {
  const NOW = 1_790_900_000_000;
  const queued = (id: string, q: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    pk: { S: 'HH#margaret' },
    sk: { S: `CARD#${id}` },
    data: { S: JSON.stringify({ id, ...q }) },
    ...extra,
  });

  it('replays a card nobody has acted on', () => {
    expect(isReplayable(card('c1'), NOW)).toBe(true);
  });

  it('never replays a card the resident already acted on — the device cannot remember it did (FL-013)', () => {
    expect(isReplayable(card('c1', { actedAt: { N: '1700' } }), NOW)).toBe(false);
  });

  it('never replays a door card whose visitor has gone — a stale "someone is at the door" is worse than silence', () => {
    expect(isReplayable(queued('door-a', { urgency: 'DOOR', queuedAt: NOW - 60_000, expiresAt: NOW - 1 }), NOW)).toBe(false);
    expect(isReplayable(queued('door-b', { urgency: 'DOOR', queuedAt: NOW - 6 * 60_000 }), NOW)).toBe(false);
    expect(isReplayable(queued('door-c', { urgency: 'DOOR', queuedAt: NOW - 60_000 }), NOW)).toBe(true);
  });

  it('replays deferred cards however long ago they were queued — a note waits for the resident', () => {
    expect(isReplayable(queued('note-x', { urgency: 'DEFERRED', queuedAt: NOW - 3 * 86_400_000 }), NOW)).toBe(true);
  });
});

describe('retiresCard — which presses finish a card server-side', () => {
  it('retires on Not now and on every non-door action, as before', () => {
    expect(retiresCard('dismiss')).toBe(true);
    expect(retiresCard('seen')).toBe(true);
    expect(retiresCard('reply_0')).toBe(true);
  });

  it('does not retire a door card the resident is still looking at — chime and live view keep it', () => {
    expect(retiresCard('hallway_chime')).toBe(false);
    expect(retiresCard('watch_live')).toBe(false);
  });
});
