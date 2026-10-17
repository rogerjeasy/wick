import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { checkVisitor, expectedToday, registerDidVisitorCome } from '../did_visitor_come.js';
import { allowedContext } from './toolContext.js';

describe('expectedToday — on the household clock (issue #84)', () => {
  it('reads the day where the house is: 23:30 UTC on a Monday is Tuesday in London in summer', () => {
    const lateMonday = new Date(Date.UTC(2026, 9, 12, 23, 30));
    expect(expectedToday('TUE 09:00±30m', lateMonday, 'Europe/London')).toBe(true);
    expect(expectedToday('MON 09:00±30m', lateMonday, 'Europe/London')).toBe(false);
  });

  it('is false with no pattern', () => {
    expect(expectedToday(undefined, new Date(), 'Europe/London')).toBe(false);
  });
});

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

describe('registerDidVisitorCome (registered tool handler, end to end)', () => {
  function mockDdbFor(householdPolicy: unknown) {
    return vi.fn().mockImplementation((cmd) => {
      const key = (cmd as { input: { Key?: { sk?: { S?: string } } } }).input.Key;
      if (key?.sk?.S === 'META') {
        return Promise.resolve({ Item: { policy: { S: JSON.stringify(householdPolicy) } } });
      }
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({
          Item: { data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } },
        });
      }
      return Promise.resolve({
        Items: [{ personId: { S: 'maria' }, type: { S: 'presence' }, sk: { S: 'EVT#001700000000000#a' } }],
      });
    });
  }

  it('answers normally under the default (unrestricted) policy', async () => {
    const ddb = { send: mockDdbFor(DEFAULT_POLICY) } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerDidVisitorCome(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria' } });
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as { visited: boolean; name: string };

    expect(parsed).toMatchObject({ visited: true, name: 'Maria' });
  });

  it('withholds the whole answer when the household policy excludes PRESENCE (Fix 2)', async () => {
    // Same trust-surface bug class the NEVER_TO_FAMILY gap fixed in
    // get_resident_shared_view: that tool already tells a family member
    // PRESENCE is excluded, so did_visitor_come must not answer anyway.
    const storedPolicy = { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE' as const] };
    const ddb = { send: mockDdbFor(storedPolicy) } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerDidVisitorCome(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'did_visitor_come', arguments: { personId: 'maria' } });
    const content = result.content as { type: string; text: string }[];

    // Must read as a refusal, not silently answer with the real visit data.
    expect(content[0]!.text).not.toContain('"visited"');
    expect(content[0]!.text).toContain('keeping to themselves');
  });
});
