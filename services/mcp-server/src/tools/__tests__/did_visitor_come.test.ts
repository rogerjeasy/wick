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

/**
 * A table of one roster entry, the presence rows asked for (EVT#) and the
 * visits (VISIT#): each Query is answered by the prefix it asks from.
 */
function table({ atDoor = [] as Record<string, unknown>[], visits = [] as Record<string, unknown>[], roster = true } = {}) {
  return vi.fn().mockImplementation((cmd) => {
    if (cmd.constructor.name === 'GetItemCommand') {
      return Promise.resolve(roster ? { Item: { data: { S: JSON.stringify({ personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' }) } } } : { Item: undefined });
    }
    const from = (cmd as { input: { ExpressionAttributeValues: Record<string, { S?: string }> } }).input.ExpressionAttributeValues[':from']?.S ?? '';
    return Promise.resolve({ Items: from.startsWith('VISIT#') ? visits : atDoor });
  });
}

const doorAt = (ms: number) => ({ personId: { S: 'maria' }, type: { S: 'presence' }, sk: { S: `EVT#${String(ms).padStart(15, '0')}#a` } });
const visitRow = (ms: number, answer?: 'confirmed' | 'disputed', personId = 'maria') => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `VISIT#${String(ms).padStart(15, '0')}#${personId}` },
  personId: { S: personId },
  name: { S: personId === 'maria' ? 'Maria' : 'Tom' },
  arrivedAt: { N: String(ms) },
  ...(answer ? { answer: { S: answer }, askedAt: { N: String(ms + 3_600_000) } } : {}),
});

describe('checkVisitor — the door when she was expected, and her word, kept apart', () => {
  const TUESDAY = new Date('2023-11-14T00:00:00.000Z');
  const NINE = Date.parse('2023-11-14T09:02:00.000Z');

  it('a ring during Maria’s window that nobody confirmed is the door when she was expected — never that Maria came (the courier case)', async () => {
    const ddb = { send: table({ atDoor: [doorAt(NINE)] }) } as unknown as DynamoDBClient;

    const result = await checkVisitor(ddb, 'hh-1', 'maria', TUESDAY);

    expect(result).toEqual({ confirmed: false, doorWhenExpected: true, at: NINE, name: 'Maria', expectedToday: true });
    expect(result).not.toHaveProperty('visited');
  });

  it('is confirmed only when the resident said "Yes, that\u2019s right" about that day’s visit', async () => {
    const ddb = { send: table({ atDoor: [doorAt(NINE)], visits: [visitRow(NINE, 'confirmed')] }) } as unknown as DynamoDBClient;

    expect(await checkVisitor(ddb, 'hh-1', 'maria', TUESDAY)).toEqual({ confirmed: true, doorWhenExpected: true, at: NINE, name: 'Maria', expectedToday: true });
  });

  it('is not confirmed by a visit she has not answered, one she said was not right, another visitor’s, or one on another day', async () => {
    const WEDNESDAY_NINE = Date.parse('2023-11-15T09:02:00.000Z');
    for (const visits of [[visitRow(NINE)], [visitRow(NINE, 'disputed')], [visitRow(NINE, 'confirmed', 'tom')], [visitRow(WEDNESDAY_NINE, 'confirmed')]]) {
      const ddb = { send: table({ atDoor: [doorAt(NINE)], visits }) } as unknown as DynamoDBClient;
      expect((await checkVisitor(ddb, 'hh-1', 'maria', TUESDAY)).confirmed).toBe(false);
    }
  });

  it('reports neither when nothing was noted that day', async () => {
    const ddb = { send: table() } as unknown as DynamoDBClient;

    expect(await checkVisitor(ddb, 'hh-1', 'maria', TUESDAY)).toEqual({ confirmed: false, doorWhenExpected: false, name: 'Maria', expectedToday: true });
  });

  it('reports unknown when the person is not on the roster', async () => {
    const ddb = { send: table({ roster: false }) } as unknown as DynamoDBClient;

    expect(await checkVisitor(ddb, 'hh-1', 'ghost', TUESDAY)).toEqual({ confirmed: false, doorWhenExpected: false, name: undefined, expectedToday: false });
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
    const parsed = JSON.parse(content[0]!.text) as { confirmed: boolean; doorWhenExpected: boolean; name: string };

    expect(parsed).toMatchObject({ confirmed: false, doorWhenExpected: true, name: 'Maria' });
    expect(parsed).not.toHaveProperty('visited');
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
    expect(content[0]!.text).not.toContain('"doorWhenExpected"');
    expect(content[0]!.text).not.toContain('"confirmed"');
    expect(content[0]!.text).toContain('keeping to themselves');
  });
});
