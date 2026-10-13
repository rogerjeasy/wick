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

  it('sends a note through the sender the server was given, and by no other way (INV-2)', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await h.store.setMemberStatus(sarah.householdId, sarah.userId, 'allowed', Date.now());
    const { client } = await mcpClient(h, sarah);

    const result = await client.callTool({ name: 'send_note_to_tv', arguments: { message: 'Lunch on Sunday?' } });

    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ sent: true });
    // The test server's own sender received it: nothing reached a real table or a real television.
    expect(h.cards.map((c) => c.card)).toContainEqual(expect.objectContaining({ type: 'MESSAGE', transcript: 'Lunch on Sunday?', householdId: sarah.householdId }));
  });

  it('exposes exactly the twenty-one deployed tools — the registered set IS the deploy contract', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const { client } = await mcpClient(h, sarah);

    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'add_regular_visitor',
        'answer_door_request',
        'answer_reach_request',
        'answer_watch_together',
        'did_visitor_come',
        'expect_visit',
        'get_door_request',
        'get_light',
        'get_reach_request',
        'get_replies',
        'get_resident_shared_view',
        'get_today',
        'get_visits',
        'get_watch_together',
        'get_week_narrative',
        'get_whats_different',
        'invite_to_watch',
        'join_watch_together',
        'list_regular_visitors',
        'send_note_to_tv',
        'withdraw_watch_invitation',
      ].sort(),
    );
  });

  it('keeps no session: a client is handed no session id, and is answered all the same', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const { client, transport } = await mcpClient(h, sarah);

    expect(transport.sessionId).toBeUndefined();
    const result = await client.callTool({ name: 'get_resident_shared_view', arguments: {} });

    expect(JSON.parse(textOf(result))).toHaveProperty('sharedWithFamily');
  });

  /** One JSON-RPC request, straight over HTTP, as a client that never initialized here would send it. */
  const rpc = (h: { base: string }, token: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });
  const TOOLS_LIST = { jsonrpc: '2.0', id: 7, method: 'tools/list' };

  it('answers a request that never initialized here — what a client meets after a redeploy, or on a second instance', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await rpc(h, sarah.tokens.access_token, TOOLS_LIST);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('get_week_narrative');
  });

  it('answers a client still sending the session id it was given before a restart', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await rpc(h, sarah.tokens.access_token, TOOLS_LIST, { 'mcp-session-id': '7d3f1b0e-from-before-the-restart' });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('serves two clients at once', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);

    const a = await mcpClient(h, sarah);
    const b = await mcpClient(h, sarah);

    const [fromB, fromA] = await Promise.all([
      b.client.callTool({ name: 'get_resident_shared_view', arguments: {} }),
      a.client.callTool({ name: 'get_resident_shared_view', arguments: {} }),
    ]);
    expect(JSON.parse(textOf(fromB))).toHaveProperty('sharedWithFamily');
    expect(JSON.parse(textOf(fromA))).toHaveProperty('sharedWithFamily');
  });

  it('has no stream to open and no session to end: GET and DELETE are refused, plainly', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const auth = { authorization: `Bearer ${sarah.tokens.access_token}` };

    expect((await fetch(`${h.base}/mcp`, { method: 'GET', headers: { ...auth, accept: 'text/event-stream' } })).status).toBe(405);
    expect((await fetch(`${h.base}/mcp`, { method: 'DELETE', headers: auth })).status).toBe(405);
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

  it('answers on the very next question once the resident has pressed Allow — no relinking', async () => {
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

  it('treats a session id as nothing: with somebody else’s token the answer is about their own home, never the other', async () => {
    const { h, send } = await server();
    const sarah = await linkNewOrganiser(h);
    const priya = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');
    await residentAllows(h, sarah.householdId, sarah.userId);
    await residentAllows(h, priya.householdId, priya.userId);

    send.mockClear();
    const res = await fetch(`${h.base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${priya.tokens.access_token}`,
        // Anything at all: there is no session for it to name.
        'mcp-session-id': 'a-session-id-seen-on-sarahs-screen',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_today', arguments: {} } }),
    });

    expect(res.status).toBe(200);
    expect(new Set(householdKeysRead(send))).toEqual(new Set([`HH#${priya.householdId}`]));
  });
});
