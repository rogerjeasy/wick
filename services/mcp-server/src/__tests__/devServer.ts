/**
 * Test-only: the whole family journey in a browser, with no AWS.
 *
 *   npx vite-node -c vitest.config.ts services/mcp-server/src/__tests__/devServer.ts
 *
 * Starts the real server (harness.ts: in-memory store, in-memory identity
 * provider whose confirmation code is always 123456) on :3300, and serves
 * apps/sim-alexa on :4173. Two stand-ins for what is not running here:
 *
 *   - the television's code is always 123456 — for the resident's television,
 *     and for one connected as "Mine" (a family member's own), which is filed
 *     apart and has no screen here
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
 *   - "Shall I tell …?": GET http://127.0.0.1:3300/dev/different looks for
 *     anything different in those homes and puts the question on the stand-in
 *     television — the agent plane's own ask.ts, over the demo home's
 *     history; GET /dev/tell (or /dev/tell?answer=keep) is the resident's
 *     press on every question still open — answer.ts, which nudges the
 *     browsers when the answer is "tell"
 *
 *   - Watching together: GET /dev/watch stands in for the remote and the
 *     player. `?press=accept` (or decline, start, not_now, or an answer's
 *     key) presses that button on the newest invitation of every home;
 *     `?player=pause|play|stop` and `?player=seek&to=<ms>` work the film
 *     once it is started. Each press and each position goes through the
 *     edge's own conditional updates (edge-device watch-together.mjs), and
 *     the player says where it is as the television's does (tv-vega
 *     togetherReporter.ts): at each change, and every few seconds while it
 *     plays. So what the family app follows here is what it would follow
 *     from a television.
 *     The films themselves are fetched through /dev/programmes, which adds
 *     the cross-origin header a browser's HLS player needs.
 *
 *   - The light in the window: GET /dev/light lights it, as a television in
 *     use today does (the stamp the edge writes when someone is at it);
 *     /dev/light?put=out is the resident putting it out for the day, and
 *     /dev/light?put=again lighting it again. Who looked in is printed
 *     here as the television's home screen would be told it.
 *
 *   - Hold for Sarah: GET /dev/reach stands in for the two-second hold on OK
 *     and the resident's press on "Yes, ask …" (/dev/reach?kind=hello for
 *     "Just say hello"), in every home that connected the stand-in
 *     television. The request is made by the agent plane's own ask.ts: one
 *     person is asked — the first in the circle — and their browsers are
 *     nudged for real. The three minutes are not waited for: the timer is
 *     kept here, and GET /dev/reach?next=1 fires it now through the agent
 *     plane's own due.ts, which asks the next person, or says that nobody
 *     has answered yet. What the television would show is printed here.
 *
 *   - The visit, witnessed: GET /dev/visit stands in for the door, twice, in
 *     every home that connected the stand-in television — a regular visitor
 *     (the demo home's Maria) seen arriving fifty minutes ago, and somebody
 *     seen leaving twelve minutes ago — through the agent plane's own
 *     note.ts, and then for the television saying its resident is there:
 *     ask.ts puts "Is this right? Maria was here on … from … to …" on the
 *     stand-in television. GET /dev/visit?press=right is the resident's
 *     "Yes, that's right" on every such question still open, and
 *     ?press=wrong her "No, that's not right" — answer.ts, which then asks
 *     "Shall I tell …?" (answered, like any other, by /dev/tell). What the
 *     family is given is get_visits: "were the visits confirmed?"
 *
 *   - The television speaks her language: the family app's own card asks
 *     ("what language is Mum's television in?", then "Ask Margaret for
 *     Spanish") through the server's real /api/language, and the question is
 *     printed here as the television would show it, in both languages.
 *     GET /dev/language is her press on "Sí, en español" (or "Yes, in
 *     English") in every home that connected the stand-in television, and
 *     /dev/language?press=no her "No" — what the edge will do with that
 *     press: only a question still open is answered, a yes makes it the
 *     television's language, a no is kept with when it was said (it stands
 *     for a week, and the same language is refused until then), and either
 *     answer closes the question. The card in the family app says so within
 *     a few seconds. Taking a question back in the card is kept too, by the
 *     server's real route: that language is refused for a day, and the card
 *     says when it can be asked again.
 *
 *   - The mantelpiece: the family app's own card sends a picture ("send Mum
 *     a picture") through the server's real POST /api/photos, into a bucket
 *     kept in memory here, past a stand-in for the one look taken at it.
 *     GET /dev/photos says what the bucket holds — each picture's size, its
 *     tag, and whether its bytes still carry anything of where or when it
 *     was taken. /dev/photos?moderation=refuse makes that look refuse every
 *     picture, ?moderation=down makes it fail (and so refuse: it fails
 *     closed), ?moderation=pass puts it back. Every picture that gets as far
 *     as that look is a try, and a member has twenty a day: the twenty-first
 *     is refused before the look, as it is deployed. /dev/photos?press=keep and
 *     ?press=thanks are her press on every picture still waiting, in every
 *     home that connected the stand-in television — what the edge will do
 *     with it: either marks the picture seen, and "Keep it" also puts it on
 *     her mantelpiece; ?press=take_down takes everything off it again. The
 *     family app says the same thing after all three: that she has seen it.
 *
 *   - Ask by voice: the family app's microphone button sends one utterance
 *     through the server's real POST /api/hear, to a stand-in for Amazon
 *     Transcribe's streaming API that reads the whole stream and says
 *     whatever /dev/hear?say=… last told it to ("How has Mum been this
 *     week?" to begin with; /dev/hear?say= with nothing says nothing was
 *     understood). It prints how many seconds it was sent, and nothing of
 *     the sound. With `WICK_DEV_HEAR=transcribe` (and AWS credentials) the
 *     real Transcribe hears it instead.
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
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { DOOR_CARD_TTL_MS, DOOR_LOOK_SK_PREFIX, LIGHT_SK, PROGRAMMES_ORIGIN, WATCH_HEARTBEAT_MS, WATCH_SK_PREFIX, programmeById, type PlaybackStateName, type QueuedCard } from '@wick/contracts';
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
import { TELL_SK_PREFIX, tellCardId, type PushKind } from '@wick/contracts';
import { REACH_ACTIONS, reachCardId, reachUnderWay } from '@wick/contracts';
import { reachStore, type ReachSend } from '@wick/agent';
import { VISIT_ACTIONS, VISIT_ASK_WITHIN_MS, isVisitPersonId, userIdOfMemberPerson, visitCardId, visitId, type RosterEntry, type VisitorMatch } from '@wick/contracts';
import { isSharedWithFamily, loadHouseholdPolicy, visitStore, type VisitSend } from '@wick/agent';
import { randomUUID } from 'node:crypto';
import { MANTEL_SK_PREFIX, PHOTO_ACTIONS, PHOTO_SK_PREFIX } from '@wick/contracts';
import { createS3PhotoObjects } from '../photos/objects.js';
import type { ModerationVerdict } from '../photos/moderation.js';
import { createMemoryObjects } from '../photos/__tests__/memoryObjects.js';
import { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { createTranscribeHearing, type TranscribeSend } from '../hear/transcribe.js';
import { noteDoorSighting } from '../../../agent/src/agents/visit/note.js';
import { buildDoorEventItem, buildPresenceItem } from '../../../agent/src/agents/door/presence.js';
import { askAboutVisits } from '../../../agent/src/agents/visit/ask.js';
import { handleVisitAnswer } from '../../../agent/src/agents/visit/answer.js';
import { buildTellCard } from '../../../agent/src/agents/tell/ask.js';
import { familyToAsk } from '../../../agent/src/agents/door/index.js';
import { DEMO_VISITOR } from '../accounts/demoHome.js';
import { handleReachAsk, type ReachDue } from '../../../agent/src/agents/reach/ask.js';
import { handleReachDue } from '../../../agent/src/agents/reach/due.js';
import { reachDueEvent } from '../../../agent/src/agents/reach/timer.js';
import { askAboutDifferences, tellRowItem } from '../../../agent/src/agents/tell/ask.js';
import { handleTellAnswer } from '../../../agent/src/agents/tell/answer.js';
import { loadShareableDifferences } from '../../../agent/src/rhythm/loadDifferent.js';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { LinkError, createLinkService } from '../../../edge-ring/lambda/household-link-service.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { answerUpdate, askedUpdate, buildQuestionCard, decisionUpdate, notNowUpdate, positionUpdate, shouldAsk, startUpdate } from '../../../edge-device/lambda/watch-together.mjs';

const API_PORT = 3300;
const APP_PORT = 4173;
// The family app's player fetches the films through this server here (see /dev/programmes below).
process.env.WICK_PROGRAMMES_ORIGIN ??= `http://127.0.0.1:${API_PORT}/dev/programmes`;
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

const nudgeBrowsers = (userIds: readonly string[], kind: PushKind = PUSH_KINDS.doorLook) =>
  nudge(userIds, kind, {
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

/** The photos bucket, in memory, and the stand-in for the one look taken at a picture (GET /dev/photos?moderation=…). */
const photoBucket = createMemoryObjects();
let photoVerdict: ModerationVerdict = 'pass';
/** What the stand-in for Transcribe says it heard (/dev/hear?say=). */
let heardWords = 'How has Mum been this week?';
const standInTranscribe: TranscribeSend = async (command) => {
  let bytes = 0;
  for await (const event of command.input.AudioStream!) bytes += event.AudioEvent?.AudioChunk?.length ?? 0;
  console.log(`transcribe (stand-in): heard ${(bytes / 32_000).toFixed(1)} s of audio and says "${heardWords}"`);
  const said = heardWords;
  return {
    TranscriptResultStream: (async function* () {
      yield { TranscriptEvent: { Transcript: { Results: said ? [{ IsPartial: false, Alternatives: [{ Transcript: said }] }] : [] } } };
    })(),
  };
};
const realTranscribe = process.env.WICK_DEV_HEAR === 'transcribe' ? new TranscribeStreamingClient({ region: process.env.AWS_REGION ?? 'us-east-1' }) : undefined;

/** Every home that has connected the stand-in television: where /dev/door rings. */
const homesWithATelevision = new Set<string>();

/** The card sender the server is given, and the one /dev/reach hands the agent plane's code. */
const sendCard = async (card: QueuedCard): Promise<void> => {
  cards.push(card);
  // As egress.ts files it, so "has Mum replied?" finds the note.
  table.put({ pk: { S: `HH#${card.card.householdId}` }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
  // Hold for Sarah: each state of the one card, as the television would now show it.
  if (card.card.type === 'REACH') console.log(`television: "${card.card.headline}"${card.card.detail ? ` ${card.card.detail}` : ''}`);
  // A picture: Wick's own words, and the two buttons that both put it away (GET /dev/photos?press=keep|thanks presses one).
  if (card.card.type === 'PHOTO') console.log(`television: "${card.card.headline}" [${card.card.actions.map((action) => action.label).join('] [')}]`);
  // The language question: both languages at once, and the two buttons she can press (GET /dev/language presses the first).
  if (card.card.type === 'LANGUAGE') {
    console.log(`television: "${card.card.headline}" ${card.card.detail} [${card.card.actions.map((action) => action.label).join('] [')}]`);
  }
};

const app = createApp(new URL(`http://127.0.0.1:${API_PORT}`), {
  store,
  identity: createFakeIdentity(),
  sendCard,
  // As egress.ts merges it: the answer to "Ask Sarah to look" lands on the stored door card.
  sendPatch: async (patch, householdId) => {
    const key = { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${patch.cardId}` } };
    const row = table.rows(key.pk.S).find((item) => item.sk?.S === key.sk.S);
    if (!row?.data?.S) return;
    const queued = JSON.parse(row.data.S) as QueuedCard;
    table.put({ ...key, data: { S: JSON.stringify({ ...queued, card: { ...queued.card, ...patch, cardId: undefined } }) } });
    console.log(`television: door card ${patch.cardId} now says "${patch.notice ?? ''}"`);
  },
  // As egress.ts takes a card back: the television puts it away.
  withdrawCard: async (householdId, cardId) => void console.log(`television (${householdId}): card ${cardId} taken back`),
  // As egress.ts tells the home screen: who looked in.
  sendHome: async (householdId, home) => void console.log(`television home screen (${householdId}):`, JSON.stringify(home)),
  // A real table's worth of answers: the demo home's history is written here and read back by the tools.
  ddb: table.ddb,
  demoAccounts: true,
  ringLinks,
  // The mantelpiece: a bucket in memory, and a look that says whatever /dev/photos?moderation= last told it to.
  photos: {
    objects: createS3PhotoObjects(photoBucket.send, 'dev-photos'),
    moderate: async (bytes) => {
      console.log(`moderation: looked at ${bytes.length} bytes and said "${photoVerdict}"`);
      return photoVerdict;
    },
  },
  hear: createTranscribeHearing(realTranscribe ? ((command, options) => realTranscribe.send(command, options)) as TranscribeSend : standInTranscribe),
  ...(process.env.WICK_DEV_ASSISTANT === 'on'
    ? { assistant: { converse: createBedrockConverse(new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? 'us-east-1' }), process.env.WICK_ASSISTANT_MODEL_ID) } }
    : {}),
  virtualTelevisionUrl: `http://127.0.0.1:${API_PORT}/dev/allow`,
  claimTelevision: async (accessToken, code, as) => {
    if (code !== '123456') return { status: 404, body: 'unknown_or_expired_code' };
    const me = (await (await fetch(`http://127.0.0.1:${API_PORT}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } })).json()) as {
      user: { userId: string };
      household: { householdId: string };
      membership: { role: string; status: string };
    };
    if (as === 'family') {
      // "Mine": a television of the signed-in person's own, decided as the pairing function decides it
      // (edge-device wick-auth.mjs mayConnectOwnTelevision) and filed as it files it — never among the resident's.
      if (me.membership.status !== 'allowed' || me.membership.role === 'neighbour') return { status: 403, body: 'not_allowed_yet' };
      const deviceId = `wick-family-tv-${me.user.userId}`;
      store.addFamilyTelevision(me.household.householdId, { deviceId, userId: me.user.userId, pairedAt: Date.now() });
      return { status: 200, body: JSON.stringify({ ok: true, kind: 'family' }) };
    }
    store.addTelevision(me.household.householdId, { deviceId: 'wick-tv', pairedAt: Date.now(), connected: true });
    homesWithATelevision.add(me.household.householdId);
    return { status: 200, body: JSON.stringify({ ok: true }) };
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

const allowedIn = async (householdId: string) =>
  (await store.listMembers(householdId)).filter((member) => member.status === 'allowed').map(({ userId, name }) => ({ userId, name }));
const tellRows = (householdId: string) => table.rows(`HH#${householdId}`).filter((row) => row.sk?.S?.startsWith(TELL_SK_PREFIX));

/** As a television saying its resident is there: anything different is asked about (agents/tell/ask.ts). */
app.get('/dev/different', async (_req, res) => {
  const asked: Record<string, readonly string[]> = {};
  for (const householdId of homesWithATelevision) {
    asked[householdId] = await askAboutDifferences(householdId, {
      loadDifferences: (hh) => loadShareableDifferences(table.ddb, 'wick', hh, Date.now(), 'Europe/London'),
      listFamily: allowedIn,
      claimOnce: async (row) => {
        if (tellRows(row.householdId).some((held) => held.differenceId?.S === row.differenceId)) return false;
        table.put(tellRowItem(row));
        return true;
      },
      release: async () => {},
      sendCard: async (card) => {
        table.put({ pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
        if (card.card.type === 'TELL') console.log(`television: "${card.card.headline}" ${card.card.detail}`);
      },
      now: Date.now,
      newCorrelationId: () => `dev-${Date.now().toString(36)}`,
    });
  }
  res.json({ asked });
});

/** As the resident's press on every question still open: "Tell" unless ?answer=keep (agents/tell/answer.ts). */
app.get('/dev/tell', async (req, res) => {
  const action = req.query.answer === 'keep' ? 'keep_private' : 'tell_family';
  const answered: Record<string, string> = {};
  for (const householdId of homesWithATelevision) {
    for (const row of tellRows(householdId).filter((held) => !held.answer)) {
      const differenceId = row.differenceId?.S ?? '';
      answered[differenceId] = await handleTellAnswer({ householdId, deviceId: 'wick-tv', cardId: tellCardId(differenceId), action, at: Date.now() }, {
        recordAnswer: async (_hh, _id, answer, at) => {
          table.put({ ...row, answer: { S: answer }, answeredAt: { N: String(at) } });
          return true;
        },
        listFamily: allowedIn,
        nudge: async (userIds) => void console.log('nudged:', await nudgeBrowsers(userIds, PUSH_KINDS.told)),
        withdraw: async () => {},
        now: Date.now,
      });
    }
  }
  res.json({ answered });
});

/**
 * Hold for Sarah: the REACH# rows in the table the tools read
 * (get_reach_request, answer_reach_request), the circle as this server's own
 * store has it, and the three-minute timer kept here instead of in
 * EventBridge Scheduler — the step of each request that is due next.
 */
const reaches = reachStore((command) => table.ddb.send(command as never) as ReturnType<ReachSend>, 'dev');
const reachCircle = async (householdId: string) =>
  (await store.listMembers(householdId))
    .filter((member) => member.status === 'allowed')
    .map(({ userId, name, role, requestedAt }) => ({ userId, name, role, since: requestedAt }));
const reachTimers = new Map<string, ReachDue>();
const reachDeps = {
  listCircle: reachCircle,
  sendCard,
  nudge: async (userIds: readonly string[], kind: PushKind) => void console.log('nudged:', await nudgeBrowsers(userIds, kind)),
  schedule: async (due: ReachDue) => {
    reachTimers.set(`${due.householdId}|${due.reachId}`, due);
    console.log(`three minutes set going for request ${due.reachId} (step ${due.step}): GET /dev/reach?next=1 fires it now`);
  },
  now: Date.now,
};

/**
 * Stands in for the remote: the two-second hold on OK, and the resident's
 * press on the card it brings — "Yes, ask …", or "Just say hello" with
 * ?kind=hello (agents/reach/ask.ts). As on the television, holding again
 * while a request is under way starts no second one (edge-device reach.mjs).
 * With ?next=1 it is the three minutes being over instead: each timer set
 * so far fires now (agents/reach/due.ts).
 */
app.get('/dev/reach', async (req, res) => {
  if (req.query.next !== undefined) {
    const fired: Record<string, string> = {};
    for (const [key, due] of [...reachTimers]) {
      reachTimers.delete(key);
      // What the one-time schedule would hand the card-action function (agents/reach/timer.ts).
      fired[due.reachId] = await handleReachDue(reachDueEvent(due).detail, { ...reachDeps, load: reaches.load, advance: reaches.advance, finish: reaches.finish });
    }
    return void res.json({ next: fired });
  }

  const kind = req.query.kind === 'hello' ? 'hello' : 'ring';
  const asked: Record<string, string> = {};
  for (const householdId of homesWithATelevision) {
    const at = Date.now();
    const latest = await reaches.latest(householdId);
    if (latest && reachUnderWay(latest, at)) {
      asked[householdId] = 'under_way';
      continue;
    }
    // The card's id is the moment she held the button, as the edge names the offer.
    const press = { householdId, deviceId: 'wick-tv', cardId: reachCardId(String(at)), action: kind === 'hello' ? REACH_ACTIONS.hello : REACH_ACTIONS.ring, at };
    asked[householdId] = await handleReachAsk(press, { ...reachDeps, claimOnce: reaches.claimOnce });
  }
  res.json({ kind, asked });
});

/**
 * The visit, witnessed: the VISIT# rows in the table get_visits reads, written
 * and answered by the agent plane's own code (services/agent agents/visit)
 * through its own store — so the conditions that keep a visit asked about
 * once, and answered once, are the real ones.
 */
const visits = visitStore((command) => table.ddb.send(command as never) as ReturnType<VisitSend>, 'dev');
/** Where the house is: as the server this starts reads it (server.ts, tools/get_visits.ts), so the card and the answer agree. */
const VISIT_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';
const VISIT_BEGAN_AGO_MS = 50 * 60_000;
const VISIT_LEFT_AGO_MS = 12 * 60_000;

/** Who the door takes the visitor for: the home's own Maria, else another regular visitor it has, else the demo home's. */
function regularVisitor(householdId: string): RosterEntry {
  const roster = table.rows(`HH#${householdId}`)
    .filter((row) => row.sk?.S?.startsWith('PER#'))
    .flatMap((row) => (row.data?.S ? [JSON.parse(row.data.S) as RosterEntry] : []));
  return (
    roster.find((person) => person.personId === DEMO_VISITOR.personId) ??
    roster.find((person) => isVisitPersonId(person.personId) && userIdOfMemberPerson(person.personId) === undefined) ??
    DEMO_VISITOR
  );
}

/** The family the resident allows — not a neighbour, who is shown nothing (AGENTS.md). */
const familyAllowedIn = async (householdId: string) =>
  (await store.listMembers(householdId)).filter((member) => member.status === 'allowed' && member.role !== 'neighbour').map(({ userId, name }) => ({ userId, name }));

/**
 * Stands in for the door and for the television. With no `press`: a regular
 * visitor is seen arriving and somebody is seen leaving (note.ts), and the
 * resident, now at the television, is asked whether that is right (ask.ts).
 * With ?press=right or ?press=wrong it is her answer to every such question
 * still open (answer.ts); a "No" becomes "Shall I tell …?", filed and shown
 * as actionLambda.ts files and shows it.
 */
app.get('/dev/visit', async (req, res) => {
  const press = typeof req.query.press === 'string' ? req.query.press : undefined;

  if (press !== undefined) {
    if (press !== 'right' && press !== 'wrong') return void res.status(400).json({ error: 'press=right|wrong, or no press for a visit the door has noted' });
    const answered: Record<string, string> = {};
    const offered: Record<string, string> = {};
    for (const householdId of homesWithATelevision) {
      const now = Date.now();
      const open = (await visits.recent(householdId, now - VISIT_ASK_WITHIN_MS)).filter((visit) => visit.askedAt !== undefined && visit.answer === undefined);
      for (const visit of open) {
        const id = visitId(visit);
        const detail = { householdId, deviceId: 'wick-tv', cardId: visitCardId(id), action: press === 'right' ? VISIT_ACTIONS.right : VISIT_ACTIONS.wrong, at: now };
        answered[id] = await handleVisitAnswer(detail, {
          answer: visits.answer,
          withdraw: async (hh, cardId) => void console.log(`television (${hh}): card ${cardId} taken back`),
          // As actionLambda.ts decides it: somebody she allows, who she shares her visitors and the shape of her week with.
          whoToTell: async (hh) => {
            const policy = await loadHouseholdPolicy(table.ddb, 'dev', hh);
            if (!isSharedWithFamily('PRESENCE', policy) || !isSharedWithFamily('RHYTHM', policy)) return undefined;
            return familyToAsk((await familyAllowedIn(hh)).map((member) => member.name));
          },
          offerToTell: async (offer) => {
            if (tellRows(offer.householdId).some((held) => held.differenceId?.S === offer.differenceId)) return false;
            table.put(tellRowItem({
              householdId: offer.householdId,
              differenceId: offer.differenceId,
              kind: 'visit_disputed',
              factClass: 'PRESENCE',
              sentence: offer.sentence,
              at: offer.at,
              askedAt: offer.now,
              weeksObserved: 0,
            }));
            const card = buildTellCard({ ...offer, correlationId: `dev-${offer.now.toString(36)}` });
            await sendCard(card);
            if (card.card.type === 'TELL') {
              console.log(`television: "${card.card.headline}" ${card.card.detail}`);
              offered[id] = `${card.card.headline} ${card.card.detail}`;
            }
            return true;
          },
          now: () => now,
          timeZone: VISIT_TZ,
        });
      }
    }
    return void res.json({ press, answered, ...(press === 'wrong' ? { offered } : {}) });
  }

  const noted: Record<string, { visitor: string; door: string[]; asked: readonly string[]; television: string[] }> = {};
  for (const householdId of homesWithATelevision) {
    const now = Date.now();
    const visitor = regularVisitor(householdId);
    // What the Door agent's roster match hands on (door/roster.ts): by the day and the time, never by a face.
    const match: VisitorMatch = { personId: visitor.personId, name: visitor.name, basis: 'schedule', expectedToday: true, confidence: 1 };
    const door = [
      await noteDoorSighting({ householdId, match, at: now - VISIT_BEGAN_AGO_MS }, visits),
      // Somebody at the door again, and the door cannot tell who: taken as the visitor leaving.
      await noteDoorSighting({ householdId, match: undefined, at: now - VISIT_LEFT_AGO_MS }, visits),
    ];
    // The timeline rows the Door function writes for the same two sightings (door/lambda.ts): the arrival as a
    // door event and the visitor's presence, the leaving as a door event. Without them this home would say
    // Maria has not come today (did_visitor_come) while listing her visit (get_visits).
    if (door[0] === 'arrived') {
      table.put(buildDoorEventItem(householdId, now - VISIT_BEGAN_AGO_MS, randomUUID()));
      table.put(buildPresenceItem(householdId, match, now - VISIT_BEGAN_AGO_MS, randomUUID()));
    }
    if (door[1] === 'left') table.put(buildDoorEventItem(householdId, now - VISIT_LEFT_AGO_MS, randomUUID()));
    const television: string[] = [];
    const asked = await askAboutVisits(householdId, {
      recent: visits.recent,
      claimAsk: visits.claimAsk,
      releaseAsk: visits.releaseAsk,
      sendCard: async (card) => {
        await sendCard(card);
        if (card.card.type !== 'VISIT') return;
        television.push(`${card.card.headline} ${card.card.detail}`);
        console.log(`television: "${card.card.headline}" ${card.card.detail}`);
      },
      now: () => now,
      timeZone: VISIT_TZ,
    });
    noted[householdId] = { visitor: visitor.name, door, asked, television };
  }
  res.json({ noted });
});

/**
 * The mantelpiece: what the bucket holds, the stand-in for moderation, and
 * the resident's press on every picture still waiting — the rows the edge
 * will write (packages/contracts mantel.ts): `seenAt` on the picture's own
 * row at either press, and a row on her mantelpiece when she keeps it. The
 * server reads only the first, so the family app cannot tell which it was.
 */
app.get('/dev/hear', (req, res) => {
  if (typeof req.query.say === 'string') heardWords = req.query.say;
  res.json({ say: heardWords, transcribe: realTranscribe ? 'real' : 'stand-in' });
});

app.get('/dev/photos', (req, res) => {
  const moderation = typeof req.query.moderation === 'string' ? req.query.moderation : undefined;
  if (moderation !== undefined) {
    if (moderation !== 'pass' && moderation !== 'refuse' && moderation !== 'down') return void res.status(400).json({ error: 'moderation=pass|refuse|down' });
    photoVerdict = moderation === 'down' ? 'unchecked' : moderation;
    return void res.json({ moderation: photoVerdict });
  }

  const press = typeof req.query.press === 'string' ? req.query.press : undefined;
  if (press !== undefined) {
    if (press !== PHOTO_ACTIONS.keep && press !== PHOTO_ACTIONS.thanks && press !== 'take_down') return void res.status(400).json({ error: 'press=keep|thanks|take_down' });
    const pressed: Record<string, string[]> = {};
    for (const householdId of homesWithATelevision) {
      const pk = { S: `HH#${householdId}` };
      const rows = table.rows(pk.S);
      if (press === 'take_down') {
        const kept = rows.filter((row) => row.sk?.S?.startsWith(MANTEL_SK_PREFIX));
        for (const row of kept) void table.ddb.send({ constructor: { name: 'DeleteItemCommand' }, input: { Key: { pk, sk: row.sk! } } } as never);
        pressed[householdId] = kept.map((row) => row.sk!.S!.slice(MANTEL_SK_PREFIX.length));
        continue;
      }
      const waiting = rows.filter((row) => row.sk?.S?.startsWith(PHOTO_SK_PREFIX) && row.seenAt === undefined);
      const now = { N: String(Date.now()) };
      for (const row of waiting) {
        const photoId = row.sk!.S!.slice(PHOTO_SK_PREFIX.length);
        table.put({ ...row, seenAt: now });
        if (press === PHOTO_ACTIONS.keep) table.put({ pk, sk: { S: `${MANTEL_SK_PREFIX}${photoId}` }, photoId: { S: photoId }, keptAt: now });
        console.log(`television (${householdId}): she pressed "${press === PHOTO_ACTIONS.keep ? 'Keep it' : 'Thank you'}" on a picture`);
      }
      pressed[householdId] = waiting.map((row) => row.sk!.S!.slice(PHOTO_SK_PREFIX.length));
    }
    return void res.json({ press, pressed });
  }

  // What is in the bucket. Never the bytes: their size, their tag, and whether they still say where or when.
  const has = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));
  res.json({
    moderation: photoVerdict,
    objects: [...photoBucket.objects].map(([key, object]) => ({
      key,
      bytes: object.bytes.length,
      contentType: object.contentType,
      tagging: object.tagging,
      jpeg: object.bytes[0] === 0xff && object.bytes[1] === 0xd8,
      exif: has(object.bytes, 'Exif'),
      gps: has(object.bytes, 'GPS'),
    })),
    requests: photoBucket.sent.map((request) => request.name),
  });
});

/**
 * The television speaks her language: the resident's press on the LANGUAGE
 * card, as the edge will have it (the store's own stand-in, memoryStore.ts
 * answerLanguage). Yes unless ?press=no. Nothing here can set a language
 * nobody asked for: a home with no question open is left exactly as it was.
 */
app.get('/dev/language', (req, res) => {
  const press = req.query.press === 'no' ? 'no' : 'yes';
  const speaks: Record<string, string> = {};
  for (const householdId of homesWithATelevision) {
    const language = store.answerLanguage(householdId, press);
    if (language === undefined) continue;
    speaks[householdId] = language;
    console.log(`television (${householdId}): she pressed ${press}; it speaks ${language}`);
  }
  res.json({ press, speaks });
});

/**
 * The light in the window: the television being in use today, and the
 * resident's press on the Light card — the rows the edge would have written
 * (edge-device television-active.mjs, light.mjs).
 */
app.get('/dev/light', (req, res) => {
  const put = typeof req.query.put === 'string' ? req.query.put : 'lit';
  const now = { N: String(Date.now()) };
  for (const householdId of homesWithATelevision) {
    const pk = { S: `HH#${householdId}` };
    if (put === 'out') table.put({ pk, sk: { S: LIGHT_SK }, outAt: now });
    else if (put === 'again') table.put({ pk, sk: { S: LIGHT_SK } });
    else table.put({ pk, sk: { S: 'DEV#wick-tv' }, activeSignalAt: now });
  }
  res.json({ light: put, homes: [...homesWithATelevision] });
});

/**
 * Watching together: the remote and the player of the stand-in television.
 * One film at a time, for whichever session was started last.
 */
type WatchRow = Record<string, { S?: string; N?: string }>;
const applied = async (update: object | undefined): Promise<WatchRow | undefined> => {
  if (!update) return undefined;
  try {
    return ((await table.ddb.send(new UpdateItemCommand(update as never))) as { Attributes?: WatchRow }).Attributes ?? {};
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return undefined;
    throw err;
  }
};

interface DevPlayer {
  readonly householdId: string;
  readonly sessionId: string;
  readonly programmeId: string;
  state: PlaybackStateName;
  positionMs: number;
  movedAt: number;
  saidAt: number;
}
let player: DevPlayer | undefined;

/** Moves the film on, and says where it is: always when `say` (something changed), otherwise every few seconds while it plays. */
async function playerTick(say = false): Promise<void> {
  if (!player) return;
  const now = Date.now();
  const film = programmeById(player.programmeId)!;
  if (player.state === 'PLAYING') {
    player.positionMs = Math.min(film.durationMs, player.positionMs + (now - player.movedAt));
    if (player.positionMs >= film.durationMs) {
      player.state = 'STOPPED';
      say = true;
    }
  }
  player.movedAt = now;
  if (!say && (player.state !== 'PLAYING' || now - player.saidAt < WATCH_HEARTBEAT_MS)) return;
  player.saidAt = now;

  const { householdId, sessionId, state, positionMs } = player;
  const event = { t: 'watch_position', sessionId, state, positionMs, contentId: film.id, at: now };
  const row = await applied(positionUpdate({ table: 'dev', householdId, event, now }));
  console.log(`television: ${state} at ${Math.round(positionMs / 1000)}s${row ? '' : ' (not kept)'}`);
  if (row && shouldAsk(row) && (await applied(askedUpdate({ table: 'dev', householdId, sessionId, at: now })))) {
    const question = buildQuestionCard({ householdId, item: row, now }) as QueuedCard;
    table.put({ pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${question.id}` }, data: { S: JSON.stringify(question) } });
    console.log(`television: card "${question.card.type === 'WATCH' ? `${question.card.headline} ${question.card.detail}` : ''}"`);
  }
}
setInterval(() => void playerTick(), 1000);

app.get('/dev/watch', async (req, res) => {
  const press = typeof req.query.press === 'string' ? req.query.press : undefined;
  const work = typeof req.query.player === 'string' ? req.query.player : undefined;
  const now = Date.now();

  if (work && player) {
    await playerTick();
    if (work === 'pause') player.state = 'PAUSED';
    else if (work === 'play') player.state = 'PLAYING';
    else if (work === 'stop') player.state = 'STOPPED';
    else if (work === 'seek') player.positionMs = Math.max(0, Number(req.query.to) || 0);
    player.movedAt = Date.now();
    await playerTick(true);
    return void res.json({ player: { state: player.state, positionMs: Math.round(player.positionMs) } });
  }
  if (!press) return void res.status(400).json({ error: 'press=accept|decline|start|not_now|<answer>, or player=play|pause|stop|seek&to=<ms> once a film is started' });

  const done: { householdId: string; sessionId: string; applied: boolean }[] = [];
  for (const householdId of homesWithATelevision) {
    // The newest invitation of this home.
    const newest = table.rows(`HH#${householdId}`)
      .filter((row) => row.sk?.S?.startsWith(WATCH_SK_PREFIX))
      .sort((a, b) => Number(b.createdAt?.N ?? 0) - Number(a.createdAt?.N ?? 0))[0];
    const sessionId = newest?.sessionId?.S;
    if (!newest || !sessionId) continue;
    const target = { table: 'dev', householdId, sessionId, at: now };
    const row =
      press === 'accept' ? await applied(decisionUpdate({ ...target, accepted: true }))
      : press === 'decline' ? await applied(decisionUpdate({ ...target, accepted: false }))
      : press === 'start' ? await applied(startUpdate(target))
      : press === 'not_now' ? await applied(notNowUpdate(target))
      : await applied(answerUpdate({ ...target, answer: press })).catch(() => undefined);
    done.push({ householdId, sessionId, applied: row !== undefined });
    if (press === 'start' && row) {
      player = { householdId, sessionId, programmeId: newest.programmeId!.S!, state: 'PLAYING', positionMs: 0, movedAt: now, saidAt: 0 };
    }
  }
  res.json({ press, done });
});

/** The films, fetched from where the television fetches them and handed on with the header a browser's HLS player needs. */
app.use('/dev/programmes', async (req, res) => {
  const upstream = await fetch(`${PROGRAMMES_ORIGIN}${req.path}`);
  res.status(upstream.status)
    .set('access-control-allow-origin', '*')
    .set('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
    .send(Buffer.from(await upstream.arrayBuffer()));
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
