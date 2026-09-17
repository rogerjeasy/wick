import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { loadTodayEvents, summariseEvent } from '../get_today.js';

describe('summariseEvent', () => {
  it('summarises a card_shown event', () => {
    expect(summariseEvent({ type: 'card_shown', cardId: 'door-abc' })).toBe('A card was shown on the television.');
  });

  it('summarises a card_action event with its action', () => {
    expect(summariseEvent({ type: 'card_action', cardId: 'door-abc', action: 'watch_live' })).toBe(
      'The resident chose "watch_live" on a card.',
    );
  });

  it('summarises a door event', () => {
    expect(summariseEvent({ type: 'door' })).toBe('Someone was at the front door.');
  });

  it('summarises a presence event with a person name when known', () => {
    expect(summariseEvent({ type: 'presence', personName: 'Maria' })).toBe('Maria arrived.');
  });

  it('summarises a presence event with no known person', () => {
    expect(summariseEvent({ type: 'presence' })).toBe('Someone arrived.');
  });
});

describe('loadTodayEvents', () => {
  it('queries the EVT# range for the given day and returns summaries in order', async () => {
    // sk-encoded timestamps use route.mjs's own format (`EVT#<15-digit
    // zero-padded ms>#<uuid>`) — route.mjs never writes a separate `at`
    // attribute, so the reader must derive `at` from the sort key, not from
    // an item attribute that real production rows don't have.
    const items = [
      { sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } },
      { sk: { S: 'EVT#001700000100000#b' }, type: { S: 'card_shown' }, cardId: { S: 'door-1' } },
    ];
    const send = vi.fn().mockResolvedValue({ Items: items });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual([
      { at: 1700000000000, summary: 'Someone was at the front door.' },
      { at: 1700000100000, summary: 'A card was shown on the television.' },
    ]);
    const call = send.mock.calls[0]![0]!.input;
    expect(call.TableName).toBeDefined();
    expect(call.KeyConditionExpression).toContain('BETWEEN');
  });
});
