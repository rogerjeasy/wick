import { describe, expect, it } from 'vitest';
import {
  markCardActed,
  markCardShown,
  replayedCard,
  isReplayable,
  finishedAmong,
  finishedSince,
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

  it('does not retire a note she put away with Back: it waits on her home screen for her answer', () => {
    expect(retiresCard('later')).toBe(false);
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

describe('retiresCard — asking the family to look', () => {
  it('keeps the door card: the answer arrives on it, so reconcile must still replay it', () => {
    expect(retiresCard('ask_family')).toBe(false);
  });
});

describe('finishedAmong — what a reconnecting television still holds that is already finished', () => {
  const items = [card('note-a', { actedAt: { N: '1700' } }), card('note-b'), card('week-2026-W41', { actedAt: { N: '1800' } })];

  it('names the cards it holds that were answered while it was away — on another television in the home', () => {
    expect(finishedAmong(items, ['note-a', 'note-b'])).toEqual(['note-a']);
  });

  it('names nothing the television did not say it holds', () => {
    expect(finishedAmong(items, [])).toEqual([]);
    expect(finishedAmong(items, ['note-b'])).toEqual([]);
  });

  it('leaves alone a card the server has no row for: not known to be finished', () => {
    expect(finishedAmong(items, ['note-zzz', 'note-a'])).toEqual(['note-a']);
  });

  it('reads nothing into a list that is not one, as an older television sends none', () => {
    expect(finishedAmong(items, undefined)).toEqual([]);
    expect(finishedAmong(items, 'note-a')).toEqual([]);
    expect(finishedAmong(items, [42, null, 'note-a'])).toEqual(['note-a']);
  });
});

describe('finishedSince — what was replayed a moment ago and is no longer hers to answer', () => {
  const door = (id: string, expiresAt: number, extra: Record<string, unknown> = {}) => ({
    pk: { S: 'HH#margaret' },
    sk: { S: `CARD#${id}` },
    data: { S: JSON.stringify({ id, urgency: 'DOOR', queuedAt: 1000, expiresAt }) },
    ...extra,
  });

  it('names nothing when every card replayed is as it was', () => {
    expect(finishedSince(['note-a', 'door-1'], [card('note-a'), door('door-1', 9000)], 2000)).toEqual([]);
  });

  it('names one answered in the meantime — on another television in the home', () => {
    expect(finishedSince(['note-a', 'note-b'], [card('note-a', { actedAt: { N: '1900' } }), card('note-b')], 2000)).toEqual(['note-a']);
  });

  it('names one that is gone altogether: taken back by its sender, or cleared away', () => {
    expect(finishedSince(['note-a', 'note-b'], [card('note-b')], 2000)).toEqual(['note-a']);
  });

  it('names a door card whose visitor has gone since', () => {
    expect(finishedSince(['door-1'], [door('door-1', 2000)], 1999)).toEqual([]);
    expect(finishedSince(['door-1'], [door('door-1', 2000)], 2000)).toEqual(['door-1']);
  });

  it('names only what was replayed: a finished card that was never sent just now is not this function’s to take back', () => {
    expect(finishedSince(['note-b'], [card('note-a', { actedAt: { N: '1900' } }), card('note-b')], 2000)).toEqual([]);
    expect(finishedSince([], [card('note-a', { actedAt: { N: '1900' } })], 2000)).toEqual([]);
  });

  it('keeps the order the cards were replayed in, and names each once', () => {
    expect(finishedSince(['note-c', 'note-a', 'note-c'], [], 2000)).toEqual(['note-c', 'note-a']);
  });
});
