import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createLifecycle, serve, stopOnSignals, type Running } from '../lifecycle.js';
import { startServer, type Harness } from './harness.js';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function wick(overrides: Parameters<typeof startServer>[0] = {}): Promise<{ h: Harness; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue({});
  const h = await startServer({ ddb: { send } as unknown as DynamoDBClient, ...overrides });
  closers.push(h.close);
  return { h, send };
}

describe('GET /health', () => {
  it('says the server is up and which build it is, and reads nothing to say it', async () => {
    const lifecycle = createLifecycle();
    const { h, send } = await wick({ lifecycle, about: { version: '0.2.0', commit: 'abc1234' } });
    const getHousehold = vi.spyOn(h.store, 'getHousehold');
    const getRecord = vi.spyOn(h.store, 'getRecord');

    const res = await fetch(`${h.base}/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', version: '0.2.0', commit: 'abc1234', uptimeSeconds: expect.any(Number) });
    expect(send).not.toHaveBeenCalled();
    expect(getHousehold).not.toHaveBeenCalled();
    expect(getRecord).not.toHaveBeenCalled();
  });

  it('leaves the commit out when the image was built without one', async () => {
    const { h } = await wick({ about: { version: '0.2.0' } });
    expect(await (await fetch(`${h.base}/health`)).json()).toEqual({ status: 'ok', version: '0.2.0', uptimeSeconds: expect.any(Number) });
  });

  it('answers 503 "draining" once the server is stopping, and every answer then closes its connection', async () => {
    const lifecycle = createLifecycle();
    const { h } = await wick({ lifecycle });
    lifecycle.drain();

    const health = await fetch(`${h.base}/health`);
    expect(health.status).toBe(503);
    expect(((await health.json()) as { status: string }).status).toBe('draining');
    expect(health.headers.get('connection')).toBe('close');
    expect((await fetch(`${h.base}/.well-known/oauth-authorization-server`)).headers.get('connection')).toBe('close');
  });
});

describe('what the server says about itself', () => {
  it('does not name its framework (no x-powered-by), on any answer', async () => {
    const { h } = await wick();
    for (const res of [
      await fetch(`${h.base}/health`),
      await fetch(`${h.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      await fetch(`${h.base}/.well-known/oauth-authorization-server`),
      await fetch(`${h.base}/no-such-page`),
    ]) {
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});

/** An app with one route that answers after `ms`. */
function slowApp(ms: number): express.Express {
  const app = express();
  app.get('/slow', (_req, res) => {
    setTimeout(() => res.json({ done: true }), ms);
  });
  return app;
}

async function running(app: express.Express): Promise<{ run: Running; base: string; lifecycle: ReturnType<typeof createLifecycle> }> {
  const lifecycle = createLifecycle();
  const run = await serve(app, lifecycle, 0, '127.0.0.1');
  closers.push(() => run.stop(0));
  return { run, base: `http://127.0.0.1:${run.port}`, lifecycle };
}

describe('serve — stopping', () => {
  it('keeps an idle connection open longer than the proxy in front does', async () => {
    const { run } = await running(slowApp(0));
    expect(run.server.keepAliveTimeout).toBeGreaterThan(60_000);
    expect(run.server.headersTimeout).toBeGreaterThan(run.server.keepAliveTimeout);
  });

  it('stops accepting, lets the request in flight finish, and says it drained', async () => {
    const { run, base, lifecycle } = await running(slowApp(300));
    const inFlight = fetch(`${base}/slow`);
    await new Promise((r) => setTimeout(r, 50));

    const stopped = run.stop(5_000);
    expect(lifecycle.draining).toBe(true);
    await expect(fetch(`${base}/slow`)).rejects.toThrow();

    const answered = await inFlight;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ done: true });
    await expect(stopped).resolves.toEqual({ how: 'drained' });
  });

  it('cuts off a request that outlasts the bound, and counts it', async () => {
    const { run, base } = await running(slowApp(10_000));
    const inFlight = fetch(`${base}/slow`).catch((err: unknown) => err);
    await new Promise((r) => setTimeout(r, 50));

    const started = Date.now();
    await expect(run.stop(200)).resolves.toEqual({ how: 'forced', cutOff: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await inFlight).toBeInstanceOf(Error);
  });

  it('on SIGTERM, stops and exits 0', async () => {
    const { run } = await running(slowApp(0));
    const exit = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.listenerCount('SIGINT');
    stopOnSignals(run, exit);

    process.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(log.mock.calls.map(([line]) => JSON.parse(String(line) as string).msg)).toEqual(['shutdown_started', 'shutdown_finished']);
    // The first signal is the one acted on; neither is listened for after it.
    expect(process.listenerCount('SIGINT')).toBe(before);
    log.mockRestore();
  });
});
