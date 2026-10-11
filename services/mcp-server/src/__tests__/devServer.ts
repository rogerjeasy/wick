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
 *   - the doorbell: GET http://127.0.0.1:3300/dev/door puts a door card on
 *     the stand-in television of every home that connected one, as if the
 *     resident had pressed "Ask … to look" — and nudges the browsers that
 *     turned notifications on, for real, through their own push services
 *     (a key pair is made at start-up and forgotten at exit)
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
import { DOOR_CARD_TTL_MS, DOOR_LOOK_SK_PREFIX, type QueuedCard } from '@wick/contracts';
import { createApp } from '../server.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { createBedrockConverse } from '../assistant/bedrock.js';
import { createFakeIdentity } from './harness.js';
import { createMemoryTable } from './memoryTable.js';
import { invokedRingLinks } from '../accounts/ringLinks.js';
import webpush from 'web-push';
import { PUSH_KINDS, PUSH_SK_PREFIX } from '@wick/contracts';
import { nudge, subscriptionFromItem, type StoredSubscription } from '../../../agent/src/push/nudge.js';
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
  // Nothing here can finish a sign-in at Ring: there is no Ring to have signed in at.
  exchange: async () => {
    throw Object.assign(new Error('token_exchange_failed'), { status: 400 });
  },
  finishLink: async (_householdId: string, tokens: unknown) => ({ record: tokens }),
  playgroundAllowed: true,
  now: Date.now,
});
const ringLinks = invokedRingLinks(async (request) => {
  const { action, householdId, userId, token, completion } = request as {
    action: 'status' | 'start' | 'complete' | 'playground' | 'disconnect';
    householdId: string;
    userId: string;
    token: string;
    completion: string;
  };
  try {
    if (action === 'status') return { ok: true, ...(await ringLinkService.status(householdId)) };
    if (action === 'start') return { ok: true, ...(await ringLinkService.start(householdId, userId)) };
    if (action === 'complete') return { ok: true, ...(await ringLinkService.complete(householdId, userId, completion)) };
    if (action === 'playground') return { ok: true, ...(await ringLinkService.playground(householdId, userId, token)) };
    return { ok: true, ...(await ringLinkService.disconnect(householdId)) };
  } catch (err) {
    return { ok: false, error: err instanceof LinkError ? (err as { code: string }).code : 'failed' };
  }
});

/**
 * Web Push, for real: this run's own signing keys, the public half where the
 * server reads it (accounts/push.ts), and the same nudge the agent plane
 * sends (services/agent push/nudge.ts) with the request made here.
 */
const pushKeys = webpush.generateVAPIDKeys();
table.put({ pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: pushKeys.publicKey } });

const nudgeBrowsers = (userIds: readonly string[]) =>
  nudge(userIds, PUSH_KINDS.doorLook, {
    listSubscriptions: async (userId) =>
      table.rows(`USER#${userId}`).filter((row) => row.sk?.S?.startsWith(PUSH_SK_PREFIX)).map(subscriptionFromItem).filter((s): s is StoredSubscription => s !== undefined),
    post: async (subscription, payload) => {
      try {
        const res = await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
          { vapidDetails: { ...pushKeys, subject: 'mailto:dev@wick.invalid' }, TTL: 300, urgency: 'high' },
        );
        return res.statusCode;
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        // Said here, because a push service's refusal is otherwise only a count.
        console.log(`push service ${new URL(subscription.endpoint).host} answered ${String(status)}: ${String((err as { body?: unknown }).body ?? '').slice(0, 200)}`);
        if (typeof status === 'number') return status;
        throw err;
      }
    },
    forget: async () => {},
  });

/** Every home that has connected the stand-in television: where /dev/door rings. */
const homesWithATelevision = new Set<string>();

const app = createApp(new URL(`http://127.0.0.1:${API_PORT}`), {
  store,
  identity: createFakeIdentity(),
  sendCard: async (card) => {
    cards.push(card);
    // As egress.ts files it, so "has Mum replied?" finds the note.
    table.put({ pk: { S: `HH#${card.card.householdId}` }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
  },
  // As egress.ts merges it: the answer to "Ask Sarah to look" lands on the stored door card.
  sendPatch: async (patch, householdId) => {
    const key = { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${patch.cardId}` } };
    const row = table.rows(key.pk.S).find((item) => item.sk?.S === key.sk.S);
    if (!row?.data?.S) return;
    const queued = JSON.parse(row.data.S) as QueuedCard;
    table.put({ ...key, data: { S: JSON.stringify({ ...queued, card: { ...queued.card, ...patch, cardId: undefined } }) } });
    console.log(`television: door card ${patch.cardId} now says "${patch.notice ?? ''}"`);
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
    homesWithATelevision.add(me.household.householdId);
    return { status: 200, body: JSON.stringify({ ok: true, deviceId: 'wick-tv' }) };
  },
});

/**
 * Stands in for the doorbell and the remote: a door card on the television
 * of every home, and the resident's press on "Ask … to look" — the rows the
 * Door agent and askFamily.ts would have written. The picture is a
 * placeholder, not Ring's.
 */
app.get('/dev/door', async (_req, res) => {
  const now = Date.now();
  const cardId = `door-dev-${now.toString(36)}`;
  const asked: string[] = [];
  for (const householdId of homesWithATelevision) {
    const pk = { S: `HH#${householdId}` };
    const card: QueuedCard = {
      id: cardId,
      urgency: 'DOOR',
      queuedAt: now,
      expiresAt: now + DOOR_CARD_TTL_MS,
      shownCount: 1,
      card: {
        type: 'DOOR',
        id: cardId,
        householdId,
        correlationId: cardId,
        createdAt: now,
        line: "Someone's at the front door.",
        description: 'A man in a yellow jacket holding a clipboard.',
        imageRef: 'https://picsum.photos/seed/wick-door/640/360',
        notice: 'The family has been asked to look.',
        actions: [
          { id: 'watch_live', label: 'Watch live', kind: 'primary' },
          { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
        ],
      },
    };
    table.put({ pk, sk: { S: `CARD#${cardId}` }, data: { S: JSON.stringify(card) } });
    table.put({
      pk,
      sk: { S: `${DOOR_LOOK_SK_PREFIX}${cardId}` },
      cardId: { S: cardId },
      askedAt: { N: String(now) },
      expiresAt: { N: String(now + DOOR_CARD_TTL_MS) },
      ttl: { N: String(Math.floor(now / 1000) + 86_400) },
    });
    asked.push(householdId);
  }
  // Everyone allowed in those homes, as askFamily.ts would nudge them.
  const allowed = (await Promise.all(asked.map((householdId) => store.listMembers(householdId))))
    .flat()
    .filter((member) => member.status === 'allowed')
    .map((member) => member.userId);
  res.json({ asked, cardId, nudged: await nudgeBrowsers(allowed) });
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
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
/** Published beside the page when deployed (infra/sim-alexa.tf); served from where it lives here. */
const ADDON_MANIFEST = fileURLToPath(new URL('../../../../addon-package/addon.json', import.meta.url));

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path.slice(1);
  try {
    const body = await readFile(file === 'addon.json' ? ADDON_MANIFEST : join(appDir, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(APP_PORT, () => console.log(`Family app on http://127.0.0.1:${APP_PORT}`));
