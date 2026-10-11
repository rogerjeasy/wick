import { describe, expect, it } from 'vitest';
import {
  markCardActed,
  markCardShown,
  replayedCard,
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

  it('does not retire the Week card behind "What Sarah sees", nor the sharing card on toggle or Next — only Done', () => {
    expect(retiresCard('sharing')).toBe(false);
    expect(retiresCard('toggle')).toBe(false);
    expect(retiresCard('next')).toBe(false);
    expect(retiresCard('done')).toBe(true);
  });

  it('does not retire a door card the resident is still looking at — chime and live view keep it', () => {
    expect(retiresCard('hallway_chime')).toBe(false);
    expect(retiresCard('watch_live')).toBe(false);
  });
});

describe('markCardShown — the server counts the showings a card gets', () => {
  it('adds one to the card for that household', () => {
    const input = markCardShown({ table: 'wick', householdId: 'margaret', cardId: 'note-1' });

    expect(input.Key).toEqual({ pk: { S: 'HH#margaret' }, sk: { S: 'CARD#note-1' } });
    expect(input.UpdateExpression).toBe('ADD shown :one');
    expect(input.ExpressionAttributeValues).toEqual({ ':one': { N: '1' } });
  });

  it('never creates a card the server did not send', () => {
    expect(markCardShown({ table: 'wick', householdId: 'margaret', cardId: 'made-up' }).ConditionExpression).toBe('attribute_exists(pk)');
  });
});

describe('replayedCard — what reconcile sends back', () => {
  const stored = (queued: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ data: { S: JSON.stringify(queued) }, ...extra });

  it('carries the showings counted since the card was sent', () => {
    const item = stored({ id: 'note-1', urgency: 'DEFERRED', shownCount: 0 }, { shown: { N: '2' } });

    expect(replayedCard(item)).toEqual({ id: 'note-1', urgency: 'DEFERRED', shownCount: 2 });
  });

  it('sends a card nobody has seen exactly as it was stored', () => {
    const queued = { id: 'note-1', urgency: 'DEFERRED', shownCount: 0 };

    expect(replayedCard(stored(queued))).toEqual(queued);
  });

  it('leaves a door card its own count: it goes by its clock, not by how often it was looked at', () => {
    const item = stored({ id: 'door-1', urgency: 'DOOR', shownCount: 0 }, { shown: { N: '5' } });

    expect(replayedCard(item)).toEqual({ id: 'door-1', urgency: 'DOOR', shownCount: 0 });
  });
});

