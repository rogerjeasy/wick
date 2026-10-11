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
 *   - Ring: the real linking service (edge-ring household-link-service.mjs)
 *     over an in-memory table, with Ring itself stood in for — any pasted
 *     token that starts with "playground" is accepted and lists one
 *     simulated camera; anything else is refused, as Ring refuses a bad token
 *
 * The assistant's model is the one thing with no stand-in. With
 * `WICK_DEV_ASSISTANT=on` (and AWS credentials for Bedrock) the real one
 * answers; without it there is none, and the app answers by its rules.
 *
 * Nothing here ships: the deployed entrypoint is ../index.ts.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QueuedCard } from '@wick/contracts';
import { createApp } from '../server.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createBedrockConverse } from '../assistant/bedrock.js';
import { createFakeIdentity } from './harness.js';
import { createMemoryTable } from './memoryTable.js';
import { invokedRingLinks } from '../accounts/ringLinks.js';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { LinkError, createLinkService } from '../../../edge-ring/lambda/household-link-service.mjs';

const API_PORT = 3300;
const APP_PORT = 4173;
const store = createMemoryStore();
const table = createMemoryTable();
const cards: QueuedCard[] = [];

/** The linking function's two tables and one secret store, in memory. */
type Row = Record<string, { S?: string }>;
const ringRows = new Map<string, Row>();
const ringSecrets = new Map<string, unknown>();
const rowKey = (k: Row) => `${k.pk?.S}|${k.sk?.S}`;
const conditionFailed = () => Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
const ringLinkService = createLinkService({
  table: 'dev',
  ddb: async (command: string, input: { Key?: Row; Item?: Row; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, { S?: string }> }) => {
    const holder = (row: Row | undefined) => row?.householdId?.S;
    const wanted = input.ExpressionAttributeValues?.[':hh']?.S;
    if (command === 'get') return { Item: ringRows.get(rowKey(input.Key!)) };
    if (command === 'put') {
      const existing = ringRows.get(rowKey(input.Item!));
      if (input.ConditionExpression && existing && holder(existing) !== wanted) throw conditionFailed();
      ringRows.set(rowKey(input.Item!), input.Item!);
      return {};
    }
    if (input.ConditionExpression && holder(ringRows.get(rowKey(input.Key!))) !== wanted) throw conditionFailed();
    ringRows.delete(rowKey(input.Key!));
    return {};
  },
  writeTokens: async (householdId: string, record: unknown) => void ringSecrets.set(householdId, record),
  deleteTokens: async (householdId: string) => void ringSecrets.delete(householdId),
  // Ring, stood in for. One simulated camera per home, so two demo homes do not contend for it.
  listDevices: async ({ accessToken }: { accessToken: string }) => {
    if (!accessToken.startsWith('playground')) throw Object.assign(new Error('devices_failed'), { status: 401 });
    return [{ id: `dev.camera.${accessToken.slice(-6)}`, name: 'Front Door' }];
  },
  beginAuthorization: async () => 'https://account.ring.com/account/integrations/partner-link/authorize?client_id=dev-server-stand-in',
  playgroundAllowed: true,
  now: Date.now,
});
const ringLinks = invokedRingLinks(async (request) => {
  const { action, householdId, userId, token } = request as { action: 'status' | 'start' | 'playground' | 'disconnect'; householdId: string; userId: string; token: string };
  try {
    if (action === 'status') return { ok: true, ...(await ringLinkService.status(householdId)) };
    if (action === 'start') return { ok: true, ...(await ringLinkService.start(householdId, userId)) };
    if (action === 'playground') return { ok: true, ...(await ringLinkService.playground(householdId, userId, token)) };
    return { ok: true, ...(await ringLinkService.disconnect(householdId)) };
  } catch (err) {
    return { ok: false, error: err instanceof LinkError ? (err as { code: string }).code : 'failed' };
  }
});

const app = createApp(new URL(`http://127.0.0.1:${API_PORT}`), {
  store,
  identity: createFakeIdentity(),
  sendCard: async (card) => {
    cards.push(card);
    // As egress.ts files it, so "has Mum replied?" finds the note.
    table.put({ pk: { S: `HH#${card.card.householdId}` }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
  },
  // A real table's worth of answers: the demo home's history is written here and read back by the tools.
  ddb: table.ddb,
  demoAccounts: true,
  ringLinks,
  ...(process.env.WICK_DEV_ASSISTANT === 'on'
    ? { assistant: { converse: createBedrockConverse(new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' }), process.env.WICK_ASSISTANT_MODEL_ID) } }
    : {}),
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
