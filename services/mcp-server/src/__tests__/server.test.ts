import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { linkNewOrganiser, residentAllows, startServer, type Harness, type Linked } from './harness.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A server whose household rows come from `send`: every tool call's DynamoDB request is recorded. */
async function server(): Promise<{ h: Harness; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue({ Item: undefined, Items: [] });
  const h = await startServer({ ddb: { send } as unknown as DynamoDBClient });
  closers.push(h.close);
  return { h, send };
}

async function mcpClient(h: Harness, who: Linked): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${who.tokens.access_token}` } },
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  // Same `exactOptionalPropertyTypes` accessor-vs-optional-property mismatch as
  // server.ts's own transport cast: `sessionId` is `string | undefined` on the
  // class but `string` (optional) on `Transport`. Structurally compatible
  // (verified: StreamableHTTPClientTransport `implements Transport`, SDK 1.30.0).
  await client.connect(transport as unknown as Transport);
  closers.push(() => client.close());
  return { client, transport };
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => (result.content as { text: string }[])[0]!.text;

/** The `pk` of every household row the tools asked DynamoDB for. */
const householdKeysRead = (send: ReturnType<typeof vi.fn>): string[] =>
  send.mock.calls
    .map(([command]) => (command as { input: { Key?: { pk?: { S?: string } }; ExpressionAttributeValues?: Record<string, { S?: string }> } }).input)
    .map((input) => input.Key?.pk?.S ?? input.ExpressionAttributeValues?.[':pk']?.S ?? '')
    .filter((pk) => pk.startsWith('HH#'));

describe('createApp', () => {
  it('exposes the MCP endpoint and requires auth', async () => {
    const { h } = await server();
    const res = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('exposes exactly the six deployed tools — the registered set IS the deploy contract', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const { client } = await mcpClient(h, sarah);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(
      ['did_visitor_come', 'get_replies', 'get_resident_shared_view', 'get_today', 'get_week_narrative', 'send_note_to_tv'].sort(),
    );
  });

  // `client.connect` performs the `initialize` handshake (which allocates the
  // session and stores its transport in server.ts's session map) followed
  // immediately by the mandatory `notifications/initialized` — exactly the
  // request that 400'd when a fresh, unconnected transport was built per
  // request. A third request then reuses the same stored transport.
  it('completes a real multi-request session: initialize, then reuses the session id on later requests', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const { client, transport } = await mcpClient(h, sarah);

    expect(transport.sessionId).toBeDefined();
    const result = await client.callTool({ name: 'get_resident_shared_view', arguments: {} });

    expect(JSON.parse(textOf(result))).toHaveProperty('sharedWithFamily');
  });

  // A single module-scoped McpServer, `connect()`ed once and reused for every
  // session, throws "Already connected to a transport" (Protocol.connect(),
  // installed SDK 1.30.0) the moment a SECOND real session opens without the
  // first ever closing — a page reload, a second tab, MCP Inspector alongside
  // the family app, a reconnect after token expiry.
  it('supports two independent concurrent sessions on the same server process (regression for the single-McpServer bug)', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);

    const a = await mcpClient(h, sarah);
    const b = await mcpClient(h, sarah);

    expect(b.transport.sessionId).not.toBe(a.transport.sessionId);
    const fromB = textOf(await b.client.callTool({ name: 'get_resident_shared_view', arguments: {} }));
    const fromA = textOf(await a.client.callTool({ name: 'get_resident_shared_view', arguments: {} }));
    expect(JSON.parse(fromB)).toHaveProperty('sharedWithFamily');
    expect(JSON.parse(fromA)).toHaveProperty('sharedWithFamily');
  });
});

describe('INV-9: the resident decides who can ask', () => {
  it('tells someone still waiting where the answer is waiting, and reads nothing about the home', async () => {
    const { h, send } = await server();
    const sarah = await linkNewOrganiser(h);
    const { client } = await mcpClient(h, sarah);

    const result = await client.callTool({ name: 'get_today', arguments: {} });

    expect(textOf(result)).toBe('Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.');
    expect(result.isError).not.toBe(true);
    expect(householdKeysRead(send)).toEqual([]);
  });

  it('answers on the very next question once the resident has pressed Allow — same session, no relinking', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const { client } = await mcpClient(h, sarah);
    expect(textOf(await client.callTool({ name: 'get_today', arguments: {} }))).toContain('hasn’t allowed this yet');

    await residentAllows(h, sarah.householdId, sarah.userId);

    expect(JSON.parse(textOf(await client.callTool({ name: 'get_today', arguments: {} })))).toMatchObject({ events: [] });
  });

  it('stops answering the moment the resident’s answer changes', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const { client } = await mcpClient(h, sarah);
    expect(JSON.parse(textOf(await client.callTool({ name: 'get_today', arguments: {} })))).toMatchObject({ events: [] });

    await h.store.setMemberStatus(sarah.householdId, sarah.userId, 'declined', Date.now());

    expect(textOf(await client.callTool({ name: 'get_today', arguments: {} }))).toBe('Margaret chose not to share this with you.');
  });
});

describe('INV-8: every tool reads the household the token is for', () => {
  it('reads only that household’s rows, for two people with two homes on one server', async () => {
    const { h, send } = await server();
    const sarah = await linkNewOrganiser(h);
    const priya = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');
    await residentAllows(h, sarah.householdId, sarah.userId);
    await residentAllows(h, priya.householdId, priya.userId);
    const a = await mcpClient(h, sarah);
    const b = await mcpClient(h, priya);

    send.mockClear();
    await a.client.callTool({ name: 'get_today', arguments: {} });
    expect(new Set(householdKeysRead(send))).toEqual(new Set([`HH#${sarah.householdId}`]));

    send.mockClear();
    await b.client.callTool({ name: 'get_today', arguments: {} });
    expect(new Set(householdKeysRead(send))).toEqual(new Set([`HH#${priya.householdId}`]));
  });

  it('refuses a session id presented with somebody else’s token', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const priya = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');
    await residentAllows(h, sarah.householdId, sarah.userId);
    const { transport } = await mcpClient(h, sarah);

    const res = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${priya.tokens.access_token}`,
        'mcp-session-id': transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_today', arguments: {} } }),
    });

    expect(res.status).toBe(403);
  });
});
