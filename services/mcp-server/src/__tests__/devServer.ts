/**
 * Test-only: the whole family journey in a browser, with no AWS.
 *
 *   npx vite-node -c vitest.config.ts services/mcp-server/src/__tests__/devServer.ts
 *
 * Starts the real server (harness.ts: in-memory store, in-memory identity
 * provider whose confirmation code is always 123456) on :3300, and serves
 * apps/sim-alexa on :4173. Two stand-ins for what is not running here:
 *
 *   - the television's code is always 123456
 *   - GET http://127.0.0.1:3300/dev/allow presses Allow, as the resident,
 *     for everyone who is waiting (it is also what the family app's
 *     "virtual television" link opens here)
 *   - the demo button is on
 *
 * Nothing here ships: the deployed entrypoint is ../index.ts.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import { createApp } from '../server.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import { createFakeIdentity } from './harness.js';

const API_PORT = 3300;
const APP_PORT = 4173;
const store = createMemoryStore();
const cards: QueuedCard[] = [];

const app = createApp(new URL(`http://127.0.0.1:${API_PORT}`), {
  store,
  identity: createFakeIdentity(),
  sendCard: async (card) => void cards.push(card),
  ddb: { send: async () => ({ Items: [] }) } as unknown as DynamoDBClient,
  demoAccounts: true,
  virtualTelevisionUrl: `http://127.0.0.1:${API_PORT}/dev/allow`,
  claimTelevision: async (accessToken, code) => {
    if (code !== '123456') return { status: 404, body: 'unknown_or_expired_code' };
    const me = (await (await fetch(`http://127.0.0.1:${API_PORT}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } })).json()) as {
      household: { householdId: string };
    };
    store.addTelevision(me.household.householdId, { deviceId: 'wick-tv', pairedAt: Date.now(), connected: true });
    return { status: 200, body: JSON.stringify({ ok: true, deviceId: 'wick-tv' }) };
  },
});

app.get('/dev/allow', async (_req, res) => {
  const allowed: string[] = [];
  for (const card of cards.splice(0)) {
    if (card.card.type !== 'CIRCLE') continue;
    const userId = card.id.replace(/^circle-/, '');
    await store.setMemberStatus(card.card.householdId, userId, 'allowed', Date.now());
    allowed.push(card.card.personName);
  }
  res.json({ allowed });
});

app.listen(API_PORT, () => console.log(`Wick server (in memory) on http://127.0.0.1:${API_PORT}`));

const appDir = fileURLToPath(new URL('../../../../apps/sim-alexa/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(join(appDir, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(APP_PORT, () => console.log(`Family app on http://127.0.0.1:${APP_PORT}`));
