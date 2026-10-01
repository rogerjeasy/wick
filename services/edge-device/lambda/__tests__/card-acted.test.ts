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
  it('replays a card nobody has acted on', () => {
    expect(isReplayable(card('c1'), undefined)).toBe(true);
  });

  it('never replays a card the resident already acted on — the device cannot remember it did (FL-013)', () => {
    expect(isReplayable(card('c1', { actedAt: { N: '1700' } }), undefined)).toBe(false);
  });

  it('skips the exact card the device reports it last saw', () => {
    expect(isReplayable(card('c1'), 'c1')).toBe(false);
    expect(isReplayable(card('c2'), 'c1')).toBe(true);
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
