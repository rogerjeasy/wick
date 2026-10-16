import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { RequestTiming } from '../timing.js';
import { linkNewOrganiser, residentAllows, startServer, type Harness } from './harness.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function wick(): Promise<Harness> {
  const send = vi.fn().mockResolvedValue({ Item: undefined, Items: [] });
  const h = await startServer({ ddb: { send } as unknown as DynamoDBClient });
  closers.push(h.close);
  return h;
}

const call = (h: Harness, token: string | undefined, body: unknown) =>
  fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** `auth;dur=1.2, build;dur=0.4` → { auth: 1.2, build: 0.4 } */
const phasesOf = (header: string | null): Record<string, number> =>
  Object.fromEntries((header ?? '').split(/,\s*/).filter(Boolean).map((entry) => {
    const [name, dur] = entry.split(';dur=');
    return [name!, Number(dur)];
  }));

/** The `mcp_request` lines logged while `work` ran. */
async function logged(work: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await work();
  await new Promise((r) => setTimeout(r, 20));
  const lines = log.mock.calls
    .map(([line]) => (typeof line === 'string' && line.startsWith('{') ? (JSON.parse(line) as Record<string, unknown>) : undefined))
    .filter((line): line is Record<string, unknown> => line?.msg === 'mcp_request');
  log.mockRestore();
  return lines;
}

describe('POST /mcp is timed in phases (issue #47)', () => {
  it('says where a tool call’s time went, in a Server-Timing header, after the tool has answered', async () => {
    const h = await wick();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);

    const res = await call(h, sarah.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_resident_shared_view', arguments: {} } });

    expect(res.status).toBe(200);
    // One JSON body, written when the answer is ready, so the header can carry the tool's own time.
    expect(res.headers.get('content-type')).toContain('application/json');
    const phases = phasesOf(res.headers.get('server-timing'));
    expect(Object.keys(phases)).toEqual(['auth', 'build', 'gate', 'handler', 'guard', 'total']);
    for (const ms of Object.values(phases)) expect(ms).toBeGreaterThanOrEqual(0);
    expect(phases.total).toBeGreaterThanOrEqual(phases.auth! + phases.build!);
    expect(((await res.json()) as { result: { structuredContent: object } }).result.structuredContent).toHaveProperty('sharedWithFamily');
  });

  it('times a request that never reaches a tool, too: tools/list has no gate and no handler', async () => {
    const h = await wick();
    const sarah = await linkNewOrganiser(h);

    const res = await call(h, sarah.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(Object.keys(phasesOf(res.headers.get('server-timing')))).toEqual(['auth', 'build', 'total']);
  });

  it('logs one line per request that names the call and the milliseconds, and nobody', async () => {
    const h = await wick();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);

    const lines = await logged(async () => {
      await (await call(h, sarah.tokens.access_token, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'send_note_to_tv', arguments: { message: 'Lunch on Sunday, Margaret?' } } })).text();
      await (await call(h, undefined, { jsonrpc: '2.0', id: 8, method: 'tools/list' })).text();
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ level: 'info', msg: 'mcp_request', rpc: 'tools/call', tool: 'send_note_to_tv', status: 200, ms: expect.objectContaining({ auth: expect.any(Number), total: expect.any(Number) }) });
    expect(lines[1]).toMatchObject({ msg: 'mcp_request', rpc: 'tools/list', status: 401 });
    const text = JSON.stringify(lines);
    for (const secret of [sarah.tokens.access_token, sarah.householdId, sarah.userId, 'Lunch on Sunday', 'Margaret', 'Sarah']) {
      expect(text).not.toContain(secret);
    }
  });

  it('never repeats a made-up tool name into the log', async () => {
    const h = await wick();
    const sarah = await linkNewOrganiser(h);

    const lines = await logged(async () => {
      await (await call(h, sarah.tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'Margaret Smith 07700 900123', arguments: {} } })).text();
    });

    expect(lines[0]).toMatchObject({ rpc: 'tools/call' });
    expect(lines[0]).not.toHaveProperty('tool');
  });
});

describe('RequestTiming', () => {
  it('adds up a phase crossed more than once, and writes the header in a fixed order', () => {
    const timing = new RequestTiming();
    timing.add('handler', 2);
    timing.add('auth', 1.04);
    timing.add('handler', 3);

    expect(timing.header()).toMatch(/^auth;dur=1, handler;dur=5, total;dur=\d+(\.\d)?$/);
  });
});
