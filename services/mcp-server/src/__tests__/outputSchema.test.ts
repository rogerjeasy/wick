/**
 * The tool contract: every tool says what its structured content is, and
 * what it really returns is that — checked by the SDK's own client, which
 * validates every answer against the `outputSchema` it was given by
 * tools/list (MCP 2025-11-25, Tools: Output Schema).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DOOR_ANSWERS, PROGRAMMES, REACH_ANSWERS, WATCH_ANSWERS } from '@wick/contracts';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { guardTools } from '../guardian.js';
import { createMcpServer } from '../server.js';
import { allowedContext } from '../tools/__tests__/toolContext.js';
import { answerSchema, data, say } from '../tools/result.js';
import { SOMETHING_WENT_WRONG_TEXT } from '../tools/errors.js';
import { createMemoryTable } from './memoryTable.js';
import { beginAuthorize, Browser, exchangeCode, registerClient, startServer, type Harness, type Tokens } from './harness.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

/** A guest in a demo home with six weeks of history (accounts/demoHome.ts), allowed, over real HTTP. */
async function demoGuest(): Promise<{ h: Harness; client: Client }> {
  const table = createMemoryTable();
  const h = await startServer({ demoAccounts: true, ddb: table.ddb });
  closers.push(h.close);
  const browser = new Browser(h.base);
  const oauth = await registerClient(h.base);
  const tx = await beginAuthorize(browser, oauth, { demo: '1' });
  const res = await browser.get(`/account?tx=${tx}`);
  // The demo button goes straight back to the app with a code (accounts/demo.ts).
  const location = res.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;
  const tokens = (await (await exchangeCode(h.base, oauth, code)).json()) as Tokens;
  const me = (await (await fetch(`${h.base}/api/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).json()) as {
    user: { userId: string };
    household: { householdId: string };
  };
  await h.store.setMemberStatus(me.household.householdId, me.user.userId, 'allowed', Date.now());

  const transport = new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(transport as unknown as Transport);
  closers.push(() => client.close());
  return { h, client };
}

/** Tomorrow where the house is, YYYY-MM-DD: a day every write tool accepts. */
const tomorrow = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() + 86_400_000);

/** One call of every tool, with arguments a person could give. */
const CALLS = (): [string, Record<string, unknown>][] => [
  ['get_resident_shared_view', {}],
  ['get_week_narrative', {}],
  ['get_today', {}],
  ['get_today', { day: 'yesterday' }],
  ['get_today', { day: 'someday' }],
  ['did_visitor_come', { personId: 'maria' }],
  ['did_visitor_come', { personId: 'nobody-here' }],
  ['send_note_to_tv', { message: 'Lunch on Sunday?' }],
  ['get_replies', {}],
  ['list_regular_visitors', {}],
  ['get_whats_different', {}],
  ['add_regular_visitor', { name: 'Tom', days: ['tuesday'], time: '18:00' }],
  ['add_regular_visitor', { name: 'Dr Patel', days: ['friday'], time: '10:00' }],
  ['expect_visit', { date: tomorrow(), time: '15:00' }],
  ['get_door_request', {}],
  ['answer_door_request', { requestId: 'door-1', answer: Object.keys(DOOR_ANSWERS)[0] }],
  ['invite_to_watch', { programme: PROGRAMMES[0]!.id, date: tomorrow(), time: '15:00' }],
  ['get_watch_together', {}],
  ['join_watch_together', { sessionId: 'not-a-session' }],
  ['answer_watch_together', { sessionId: 'not-a-session', answer: Object.keys(WATCH_ANSWERS)[0] }],
  ['withdraw_watch_invitation', {}],
  ['get_watch_together', {}],
  ['get_light', {}],
  ['get_reach_request', {}],
  ['answer_reach_request', { requestId: '1700000000000', answer: Object.keys(REACH_ANSWERS)[0] }],
  ['get_visits', {}],
  ['get_visits', { days: 31 }],
  ['get_pictures', {}],
];

describe('the tool contract (outputSchema)', () => {
  it('every tool the server lists declares an object output schema, with its two forms told apart', async () => {
    const { client } = await demoGuest();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(22);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema!.properties, tool.name).toHaveProperty('say');
      expect((tool.outputSchema as { anyOf?: unknown[] }).anyOf, tool.name).toHaveLength(2);
    }
  });

  it('every tool, called for real on a demo home, answers what its schema says — checked by the SDK client', async () => {
    const { client } = await demoGuest();
    const invalid = vi.spyOn(console, 'error');
    await client.listTools(); // The client keeps each tool's validator from here on.
    const called = new Set<string>();

    for (const [name, args] of CALLS()) {
      // The client throws McpError when structured content does not match the tool's outputSchema.
      const result = await client.callTool({ name, arguments: args });
      called.add(name);
      expect(result.isError, `${name} ${JSON.stringify(args)}: ${JSON.stringify(result.content)}`).toBeFalsy();
      expect(result.structuredContent, name).toBeDefined();
    }

    expect(called.size).toBe(22);
    expect(invalid.mock.calls.flat().join('\n')).not.toContain('tool_output_invalid');
  });
});

describe('the Guardian and the contract', () => {
  const SHAPE = { line: z.string() };

  async function oneTool(answer: () => object): Promise<Client> {
    const server = guardTools(new McpServer({ name: 'test', version: '0.1.0' }));
    server.registerTool('probe', { description: 'test', inputSchema: {}, outputSchema: answerSchema(SHAPE) }, async () => answer() as never);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await client.listTools();
    return client;
  }

  it('an answer the gate withholds is an error answer, which the client takes without a schema to hold it to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = await oneTool(() => data({ line: 'She has been to the doctor about her heart.' }));

    const result = await client.callTool({ name: 'probe', arguments: {} });

    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: SOMETHING_WENT_WRONG_TEXT }] });
    expect(result.structuredContent).toBeUndefined();
  });

  it('a sentence validates as `say` alone', async () => {
    const client = await oneTool(() => say('Not yet.'));
    expect((await client.callTool({ name: 'probe', arguments: {} })).structuredContent).toEqual({ say: 'Not yet.' });
  });

  it('an answer that is not what the tool declares is never sent: it fails as any answer does, and the log names the field, not its value', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await oneTool(() => data({ line: 'Maria came.', extra: 'Margaret Smith' }));

    const result = await client.callTool({ name: 'probe', arguments: {} });

    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: SOMETHING_WENT_WRONG_TEXT }] });
    const line = log.mock.calls.map(([l]) => String(l)).find((l) => l.includes('tool_output_invalid'))!;
    expect(JSON.parse(line)).toMatchObject({ msg: 'tool_output_invalid', tool: 'probe', issues: [{ code: 'unrecognized_keys' }] });
    expect(line).not.toContain('Margaret');
  });

  it('refuses `say` beside data, and data missing a field it must carry', () => {
    const schema = answerSchema(SHAPE);
    expect(schema.safeParse({ line: 'x' }).success).toBe(true);
    expect(schema.safeParse({ say: 'x' }).success).toBe(true);
    expect(schema.safeParse({ say: 'x', line: 'y' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});

describe('tools/list is made once per process (issue #47)', () => {
  const ddb = { send: async () => ({}) } as unknown as DynamoDBClient;
  const nowhere = async (): Promise<void> => {};

  async function listOf(ownList: boolean, ctx = allowedContext('hh-1')) {
    const server = createMcpServer(ddb, ctx, nowhere, nowhere, nowhere, { ownList });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      return (await client.listTools()).tools;
    } finally {
      await client.close();
    }
  }

  it('answers with exactly the list the SDK makes, whoever asks', async () => {
    const sdk = await listOf(true);
    expect(await listOf(false)).toEqual(sdk);
    expect(await listOf(false, allowedContext('hh-2', { userId: 'u_tom', name: 'Tom', role: 'neighbour' }))).toEqual(sdk);
  });
});
