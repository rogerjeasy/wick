import { afterEach, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRuntimeServer, type RuntimeHandlers } from '../server.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(handlers: RuntimeHandlers, busy: () => boolean = () => false): Promise<string> {
  server = createRuntimeServer({ handlers, busy, log: () => {} });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const invoke = (base: string, body: unknown, session = 'wick-household-margaret-000000000000') =>
  fetch(`${base}/invocations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('AgentCore Runtime contract', () => {
  it('answers GET /ping Healthy when idle', async () => {
    const base = await start({});
    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; time_of_last_update: number };
    expect(body.status).toBe('Healthy');
    expect(Number.isInteger(body.time_of_last_update)).toBe(true);
  });

  it('answers HealthyBusy while background work runs, so AgentCore keeps the session', async () => {
    const base = await start({}, () => true);
    expect(((await (await fetch(`${base}/ping`)).json()) as { status: string }).status).toBe('HealthyBusy');
  });

  it('dispatches POST /invocations by kind, with the runtime session id', async () => {
    const handler = vi.fn(async (payload: Record<string, unknown>, ctx: { sessionId: string }) => ({ echoed: payload.householdId, session: ctx.sessionId }));
    const base = await start({ 'door.action': handler });

    const res = await invoke(base, { kind: 'door.action', householdId: 'margaret' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: 'margaret', session: 'wick-household-margaret-000000000000' });
  });

  it('refuses an unknown kind with 400, never guessing a graph', async () => {
    const base = await start({});
    const res = await invoke(base, { kind: 'rm -rf' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_kind' });
  });

  it('refuses a body that is not JSON', async () => {
    const base = await start({});
    expect((await invoke(base, '{nope')).status).toBe(400);
  });

  it('answers 500 without leaking the handler\'s error text', async () => {
    const base = await start({ 'door.action': async () => { throw new Error('ring token abc123'); } });
    const res = await invoke(base, { kind: 'door.action' });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('abc123');
  });

  it('404s anything else', async () => {
    const base = await start({});
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });
});
