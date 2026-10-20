import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadTodayEvents, registerGetToday, summariseEvent } from '../get_today.js';
import { allowedContext } from './toolContext.js';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import { guardTools } from '../../guardian.js';
import type { ToolContext } from '../context.js';

describe('summariseEvent', () => {
  it('summarises a door event', () => {
    expect(summariseEvent({ type: 'door' })).toBe('Someone was at the front door.');
    // A person seen who did not ring (agent door/presence.ts): never said to have come.
    expect(summariseEvent({ type: 'door', motion: true })).toBe('Movement at the front door, and nobody rang.');
  });

  it('summarises a presence event with a person name when known', () => {
    expect(summariseEvent({ type: 'presence', personName: 'Maria' })).toBe('Someone came to the door when Maria was expected.');
  });

  it('summarises a presence event with no known person', () => {
    expect(summariseEvent({ type: 'presence' })).toBe('Someone came to the door when a regular visitor was expected.');
  });

  it('never describes how the resident uses their own television — that is not the family’s to see', () => {
    expect(summariseEvent({ type: 'card_shown', cardId: 'door-abc' })).toBeUndefined();
    expect(summariseEvent({ type: 'card_action', cardId: 'door-abc', action: 'watch_live' })).toBeUndefined();
  });

  it('says nothing about an event it does not recognise, rather than guessing', () => {
    expect(summariseEvent({ type: 'something-unknown' })).toBeUndefined();
  });
});

describe('loadTodayEvents', () => {
  it('queries the EVT# range for the given day and returns only what the family may see, in order', async () => {
    // sk-encoded timestamps use route.mjs's own format (`EVT#<15-digit
    // zero-padded ms>#<uuid>`) — route.mjs never writes a separate `at`
    // attribute, so the reader must derive `at` from the sort key.
    const items = [
      { sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } },
      { sk: { S: 'EVT#001700000100000#b' }, type: { S: 'card_shown' }, cardId: { S: 'door-1' } },
      { sk: { S: 'EVT#001700000200000#c' }, type: { S: 'card_action' }, cardId: { S: 'door-1' }, action: { S: 'watch_live' } },
    ];
    const send = vi.fn().mockResolvedValue({ Items: items });
    const ddb = { send } as unknown as DynamoDBClient;

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'));

    expect(result).toEqual({ events: [{ at: 1700000000000, summary: 'Someone was at the front door.' }], keptPrivate: [] });
    const call = send.mock.calls[0]![0]!.input;
    expect(call.TableName).toBeDefined();
    expect(call.KeyConditionExpression).toContain('BETWEEN');
  });

  it('says a ring when a visitor was expected once, not as a ring and again as expected', async () => {
    const items = [
      { sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } },
      { sk: { S: 'EVT#001700000000000#b' }, type: { S: 'presence' }, personName: { S: 'Dave the plumber' } },
      { sk: { S: 'EVT#001700000300000#c' }, type: { S: 'door' } },
    ];
    const ddb = { send: vi.fn().mockResolvedValue({ Items: items }) } as unknown as DynamoDBClient;

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'));

    expect(result.events).toEqual([
      { at: 1700000000000, summary: 'Someone came to the door when Dave the plumber was expected.' },
      { at: 1700000300000, summary: 'Someone was at the front door.' },
    ]);
  });

  it('leaves out what the resident keeps private — not even a timestamp — and says what is kept private', async () => {
    // A refusal per event would still tell the family exactly when someone
    // came. The private class is named once instead, whether or not anything
    // in it happened today.
    const items = [
      { sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } },
      { sk: { S: 'EVT#001700000100000#b' }, type: { S: 'presence' }, personName: { S: 'Maria' } },
    ];
    const send = vi.fn().mockResolvedValue({ Items: items });
    const ddb = { send } as unknown as DynamoDBClient;
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE' as const] };

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'), policy);

    expect(result).toEqual({
      events: [{ at: 1700000000000, summary: 'Someone was at the front door.' }],
      keptPrivate: ['Who visits, by name. That is something the resident keeps to themselves.'],
    });
    expect(JSON.stringify(result)).not.toContain('Maria');
    expect(JSON.stringify(result)).not.toContain('1700000100000');
  });

  it('names what is kept private even on a day nothing in it happened, so the answer reveals nothing', async () => {
    const send = vi.fn().mockResolvedValue({ Items: [] });
    const ddb = { send } as unknown as DynamoDBClient;
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['DOOR_EVENT' as const] };

    expect(await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'), policy)).toEqual({
      events: [],
      keptPrivate: ['When someone comes to the door. That is something the resident keeps to themselves.'],
    });
  });
});

describe('registerGetToday (registered tool handler, end to end)', () => {
  it('returns real event summaries under the default (unrestricted) policy', async () => {
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') return Promise.resolve({ Item: undefined });
      return Promise.resolve({
        Items: [{ sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } }],
      });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetToday(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_today', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toEqual({
      // The day answered for: today, since none was named.
      date: new Date().toISOString().slice(0, 10),
      dayInWords: expect.stringMatching(/^\w+day \d+ \w+ \d{4}$/) as unknown,
      events: [{ at: 1700000000000, summary: 'Someone was at the front door.' }],
      keptPrivate: [],
    });
  });

  it('withholds presence-derived entries end to end when the stored household policy excludes PRESENCE', async () => {
    const storedPolicy = { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE' as const] };
    const send = vi.fn().mockImplementation((cmd) => {
      if (cmd.constructor.name === 'GetItemCommand') {
        return Promise.resolve({ Item: { policy: { S: JSON.stringify(storedPolicy) } } });
      }
      return Promise.resolve({
        Items: [{ sk: { S: 'EVT#001700000000000#a' }, type: { S: 'presence' }, personName: { S: 'Maria' } }],
      });
    });
    const ddb = { send } as unknown as DynamoDBClient;

    const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
    registerGetToday(mcpServer, ddb, allowedContext('hh-1'));

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_today', arguments: {} });
    const content = result.content as { type: string; text: string }[];

    expect(content[0]!.text).not.toContain('Maria');
    expect(content[0]!.text).not.toContain('1700000000000');
    expect(content[0]!.text).toContain('keeps to themselves');
  });
});

describe('get_today — a visitor’s name the gate cannot clear (INV-4)', () => {
  /** A presence row as the door writes it, at a moment today, behind the Guardian as every tool is. */
  async function todayWith(personName: string, ctx: ToolContext = allowedContext('hh-1')) {
    const table = createMemoryTable();
    const at = Date.now() - 1000;
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `EVT#${String(at).padStart(15, '0')}#a` }, type: { S: 'presence' }, personName: { S: personName } });
    const mcpServer = guardTools(new McpServer({ name: 'test', version: '0.1.0' }), undefined, ctx.people ? () => ctx.people!() : undefined);
    registerGetToday(mcpServer, table.ddb, ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
    return client.callTool({ name: 'get_today', arguments: {} });
  }

  it('leaves the name out, and keeps the rest of the day: "Doctor Rossi" is the arranging member’s word, not everyone’s', async () => {
    const result = await todayWith('Doctor Rossi');

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { events: { summary: string }[] }).events.map((e) => e.summary)).toEqual([
      'Someone came to the door when a visitor was expected.',
    ]);
    expect(JSON.stringify(result)).not.toContain('Rossi');
  });

  it('keeps a name the gate clears, and one of the household’s own people in another script', async () => {
    const summaries = async (name: string, ctx?: ToolContext) =>
      ((await todayWith(name, ctx)).structuredContent as { events: { summary: string }[] }).events.map((e) => e.summary);

    expect(await summaries('Maria')).toEqual(['Someone came to the door when Maria was expected.']);
    expect(await summaries('Иван', { ...allowedContext('hh-1'), people: async () => ['Иван'] })).toEqual(['Someone came to the door when Иван was expected.']);
  });
});
