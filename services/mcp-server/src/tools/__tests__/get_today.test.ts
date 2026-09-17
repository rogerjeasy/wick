import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadTodayEvents, registerGetToday, summariseEvent } from '../get_today.js';

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

  it('falls back to a generic summary for an unrecognized event type', () => {
    // An unrecognized `type` (a future 5th kind, or malformed data) must not
    // fall through to `undefined` — JSON.stringify silently drops undefined
    // entries, which would make an event vanish from the response with no trace.
    expect(summariseEvent({ type: 'something-unknown' as never })).toBe('Something happened.');
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

  it('withholds presence-derived entries but keeps door entries when residentExclusions excludes PRESENCE', async () => {
    // Fix 2: get_resident_shared_view already tells a family member PRESENCE
    // is excluded via policy.residentExclusions — get_today must not answer
    // anyway. DOOR_EVENT is untouched by this policy, so a door entry in the
    // same batch must still come through with its real summary (independent
    // per-class gating, not an all-or-nothing response).
    const items = [
      { sk: { S: 'EVT#001700000000000#a' }, type: { S: 'door' } },
      { sk: { S: 'EVT#001700000100000#b' }, type: { S: 'presence' }, personName: { S: 'Maria' } },
    ];
    const send = vi.fn().mockResolvedValue({ Items: items });
    const ddb = { send } as unknown as DynamoDBClient;
    const policy = { ...DEFAULT_POLICY, residentExclusions: ['PRESENCE' as const] };

    const result = await loadTodayEvents(ddb, 'hh-1', new Date('2023-11-14T00:00:00.000Z'), policy);

    expect(result).toEqual([
      { at: 1700000000000, summary: 'Someone was at the front door.' },
      { at: 1700000100000, summary: "That's something the resident is keeping to themselves. I'm not able to share it." },
    ]);
    // Must never leak the excluded person's name into the refusal text.
    expect(result.some((e) => e.summary.includes('Maria'))).toBe(false);
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
    registerGetToday(mcpServer, ddb);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_today', arguments: {} });
    const content = result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as { summary: string }[];

    expect(parsed).toEqual([{ at: 1700000000000, summary: 'Someone was at the front door.' }]);
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
    registerGetToday(mcpServer, ddb);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'get_today', arguments: {} });
    const content = result.content as { type: string; text: string }[];

    expect(content[0]!.text).not.toContain('Maria');
    expect(content[0]!.text).toContain("keeping to themselves");
  });
});
