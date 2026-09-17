import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { checkVisitor } from '../did_visitor_come.js';

describe('checkVisitor', () => {
  it('reports a visit found within the roster schedule', async () => {
    // Presence EVT# rows have no real production writer yet (Task 7's seed
    // script will be first) — this follows get_today.ts's verified-correct
    // pattern: the timestamp lives ONLY in the sort key
    // (`EVT#<15-digit-zero-padded-ms>#<uuid>`), matching route.mjs's actual
    // card_shown/card_action writes. There is no separate `at` attribute.
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({
          Item: {
            data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) },
          },
        });
      }
      return Promise.resolve({
        Items: [{ personId: { S: 'maria' }, sk: { S: 'EVT#001700000000000#a' } }],
      });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'maria', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: true, at: 1700000000000, name: 'Maria', expectedToday: true });
  });

  it('reports no visit when nothing matches for the day', async () => {
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({
          Item: { data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } },
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'maria', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: false, name: 'Maria', expectedToday: true });
  });

  it('reports unknown when the person is not on the roster', async () => {
    const send = vi.fn().mockResolvedValue({ Item: undefined });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'ghost', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ visited: false, name: undefined, expectedToday: false });
  });
});
