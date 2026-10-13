/**
 * Sarah's television, end to end: the real express app on a real socket,
 * asked over HTTP as a television would ask it. Nothing is paired here —
 * the two rows pairing leaves behind (the television's own, and the pairing
 * key's public half) are written directly, and the token is signed by the
 * edge's own signJwt.
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DOOR_ANSWERS, PAIRING_PUBLIC_KEY_ROW, REACH_ANSWERS, familyTvCardId, type CardPatch, type FamilyTvHome, type HomeState } from '@wick/contracts';
import { reachFromItem, reachItem } from '@wick/agent';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt } from '../../../edge-device/lambda/jwt.mjs';
import { linkNewOrganiser, residentAllows, startServer, TOM, type Harness, type Linked } from './harness.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';

const MIN = 60_000;
const PICTURE = 'https://download.example/ring/frame.jpg?sig=abc';

const PAIRING = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const sign = signJwt as (claims: object, privateKeyPem: string, options: { expiresInSec: number }) => string;

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface Home {
  readonly h: Harness;
  readonly table: MemoryTable;
  readonly patches: { patch: CardPatch; householdId: string }[];
  readonly homes: { householdId: string; home: HomeState }[];
}

async function server(): Promise<Home> {
  const table = createMemoryTable();
  const patches: Home['patches'] = [];
  const homes: Home['homes'] = [];
  const h = await startServer({
    ddb: table.ddb,
    sendPatch: async (patch, householdId) => void patches.push({ patch, householdId }),
    sendHome: async (householdId, home) => void homes.push({ householdId, home }),
  });
  closers.push(h.close);
  // What pair-claim.mjs publishes when a family television is connected.
  table.put({ pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk }, publicKeyPem: { S: PAIRING.publicKey } });
  return { h, table, patches, homes };
}

/** Connects a television as this person's own, as pair-claim.mjs would with `as: 'family'`, and returns its token. */
function connectTelevision(table: MemoryTable, who: Linked, deviceId = 'tv-own'): string {
  table.put({
    pk: { S: `HH#${who.householdId}` },
    sk: { S: `FTV#${deviceId}` },
    deviceId: { S: deviceId },
    householdId: { S: who.householdId },
    userId: { S: who.userId },
    pairedAt: { N: String(Date.now()) },
    denylisted: { BOOL: false },
  });
  return sign({ deviceId, householdId: who.householdId, kind: 'family', userId: who.userId }, PAIRING.privateKey, { expiresInSec: 3600 });
}

const tv = (h: Harness, token: string | undefined, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${h.base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

const press = (h: Harness, token: string | undefined, body: unknown, path = '/tv/press', headers: Record<string, string> = {}): Promise<Response> =>
  tv(h, token, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** A stranger at the door, and the resident's press on "Ask … to look". */
function askToLook(table: MemoryTable, householdId: string, cardId = 'door-abc'): void {
  const now = Date.now();
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${cardId}` },
    data: {
      S: JSON.stringify({
        id: cardId,
        urgency: 'DOOR',
        queuedAt: now - MIN,
        expiresAt: now + 4 * MIN,
        shownCount: 0,
        card: { type: 'DOOR', id: cardId, householdId, line: "Someone's at the front door.", description: 'A man in a yellow jacket.', imageRef: PICTURE, actions: [] },
      }),
    },
  });
  table.put({ pk: { S: `HH#${householdId}` }, sk: { S: `LOOK#${cardId}` }, cardId: { S: cardId }, askedAt: { N: String(now - 30_000) } });
}

const lookRow = (table: MemoryTable, householdId: string, cardId = 'door-abc') => table.rows(`HH#${householdId}`).find((row) => row.sk?.S === `LOOK#${cardId}`);

describe('GET /tv/home', () => {
  it('shows the member’s own television the home, in the shape the television draws', async () => {
    const { h, table, homes } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    askToLook(table, sarah.householdId);

    const res = await tv(h, token, '/tv/home');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      residentName: 'Margaret',
      memberName: 'Sarah',
      light: { lit: false, line: 'The light isn’t on at Margaret’s. It may not be lit yet today, or Margaret may have put it out.' },
      cards: [
        {
          id: 'ftv-door_look-door-abc',
          kind: 'door_look',
          headline: 'Margaret has asked you to look at the door.',
          detail: 'A man in a yellow jacket.',
          pictureUrl: PICTURE,
          actions: [
            { id: 'known', label: DOOR_ANSWERS.known, kind: 'primary' },
            { id: 'dont_open', label: DOOR_ANSWERS.dont_open, kind: 'secondary' },
            { id: 'not_sure', label: DOOR_ANSWERS.not_sure, kind: 'secondary' },
          ],
        },
      ],
    } satisfies FamilyTvHome);
    // Asking for the light is a look, and the resident's own home screen is told through the server's sender.
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({ householdId: sarah.householdId, home: { lookedIn: { name: 'Sarah' } } });
  });

  it('notes one look however often the television asks', async () => {
    const { h, table, homes } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);

    for (let i = 0; i < 20; i += 1) expect((await tv(h, token, '/tv/home')).status).toBe(200);

    expect(homes).toHaveLength(1);
  });

  it('is open to the virtual television in a browser tab on another origin, preflight and all', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);

    for (const [path, method] of [['/tv/home', 'GET'], ['/tv/press', 'POST']] as const) {
      const preflight = await fetch(`${h.base}${path}`, {
        method: 'OPTIONS',
        headers: { origin: 'https://ops.example', 'access-control-request-method': method, 'access-control-request-headers': 'authorization,content-type' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
      expect(preflight.headers.get('access-control-allow-methods')).toContain(method);
    }
    const res = await tv(h, token, '/tv/home', { headers: { origin: 'https://ops.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // A refusal can be read by that page too, so it can show the sentence.
    expect((await tv(h, undefined, '/tv/home', { headers: { origin: 'https://ops.example' } })).headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 401 to no token, to nonsense, and to a person’s own access token: only a television’s token is one', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    connectTelevision(table, sarah);

    for (const token of [undefined, 'nonsense', sarah.tokens.access_token]) {
      const res = await tv(h, token, '/tv/home');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(await res.json()).toEqual({ error: 'invalid_token' });
    }
  });

  it('answers 403 to the resident’s own television, and nothing of the home', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'DEV#wick-tv' }, deviceId: { S: 'wick-tv' }, denylisted: { BOOL: false } });
    const residents = sign({ deviceId: 'wick-tv', householdId: sarah.householdId }, PAIRING.privateKey, { expiresInSec: 3600 });

    const res = await tv(h, residents, '/tv/home');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_family_television' });
  });

  it('INV-9: says the sentence, and shows nothing, until the resident has allowed the member — and again once they are removed', async () => {
    const { h, table, homes } = await server();
    const sarah = await linkNewOrganiser(h);
    const token = connectTelevision(table, sarah);
    askToLook(table, sarah.householdId);

    const waiting = await tv(h, token, '/tv/home');
    expect(waiting.status).toBe(403);
    expect(await waiting.json()).toEqual({ error: 'not_allowed', say: 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.' });
    expect(homes).toEqual([]);

    await residentAllows(h, sarah.householdId, sarah.userId);
    expect((await tv(h, token, '/tv/home')).status).toBe(200);

    await h.store.setMemberStatus(sarah.householdId, sarah.userId, 'removed', Date.now());
    const removed = await tv(h, token, '/tv/home');
    expect(removed.status).toBe(403);
    expect(await removed.json()).toEqual({ error: 'not_allowed', say: 'You are no longer part of this family circle.' });
  });

  it('INV-8: a household or a member named in the query or a header is not read', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const tom = await linkNewOrganiser(h, TOM, 'Edith');
    await residentAllows(h, tom.householdId, tom.userId);
    const token = connectTelevision(table, sarah);
    askToLook(table, tom.householdId, 'door-edith');

    const res = await tv(h, token, `/tv/home?householdId=${tom.householdId}&userId=${tom.userId}&deviceId=tv-tom`, {
      headers: { 'x-household-id': tom.householdId, 'x-user-id': tom.userId, householdid: tom.householdId },
    });

    expect(res.status).toBe(200);
    const home = (await res.json()) as FamilyTvHome;
    expect(home).toMatchObject({ residentName: 'Margaret', memberName: 'Sarah', cards: [] });
    expect(JSON.stringify(home)).not.toMatch(/Edith|Tom|door-edith/);
  });

  it('is not a way onto the family’s own surfaces: a television’s token opens neither /mcp nor /api', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);

    const mcp = await tv(h, token, '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const api = await tv(h, token, '/api/circle');

    expect(mcp.status).toBe(401);
    expect(api.status).toBe(401);
  });
});

describe('POST /tv/press', () => {
  it('puts the member’s answer on the resident’s door card through the server’s sender, once', async () => {
    const { h, table, patches } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    askToLook(table, sarah.householdId);

    const first = await press(h, token, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'dont_open' });
    const second = await press(h, token, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ done: true, say: `It is on the television now: “Sarah says: ${DOOR_ANSWERS.dont_open}”` });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ done: false, say: `Sarah has already answered: "${DOOR_ANSWERS.dont_open}"` });
    expect(patches).toEqual([{ householdId: sarah.householdId, patch: { cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS.dont_open}` } }]);

    const home = (await (await tv(h, token, '/tv/home')).json()) as FamilyTvHome;
    // The member who answered is not told again on their own screen.
    expect(home.cards).toEqual([]);
  });

  it('answers a request to ring, and the answer reaches the resident’s television as a card', async () => {
    const { h, table } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    const askedAt = Date.now() - 2 * MIN;
    table.put(reachItem({ householdId: sarah.householdId, reachId: String(askedAt), kind: 'ring', askedAt, order: [{ userId: sarah.userId, name: 'Sarah', role: 'organiser' }], asked: 1 }));
    const sentBefore = h.cards.length;

    const home = (await (await tv(h, token, '/tv/home')).json()) as FamilyTvHome;
    expect(home.cards).toMatchObject([{ id: `ftv-reach-${askedAt}`, kind: 'reach', headline: 'Margaret would like you to ring her.' }]);

    const res = await press(h, token, { cardId: home.cards[0]!.id, action: home.cards[0]!.actions[0]!.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true, say: `It is on the television now: “Sarah says: ${REACH_ANSWERS.now}”` });
    expect(h.cards.slice(sentBefore).map((c) => c.card)).toEqual([expect.objectContaining({ type: 'REACH', householdId: sarah.householdId, headline: `Sarah says: ${REACH_ANSWERS.now}` })]);
    expect(reachFromItem(table.rows(`HH#${sarah.householdId}`).find((row) => row.sk?.S === `REACH#${askedAt}`))?.answer).toMatchObject({ key: 'now', by: sarah.userId });
  });

  it('INV-8: a household or a member named in the body, the query or a header is not read — the press is the token’s', async () => {
    const { h, table, patches } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const tom = await linkNewOrganiser(h, TOM, 'Edith');
    await residentAllows(h, tom.householdId, tom.userId);
    const token = connectTelevision(table, sarah);
    // The same door card id is open in both homes.
    askToLook(table, sarah.householdId);
    askToLook(table, tom.householdId);

    const res = await press(
      h,
      token,
      { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known', householdId: tom.householdId, userId: tom.userId, memberName: 'Tom', deviceId: 'tv-tom' },
      `/tv/press?householdId=${tom.householdId}&userId=${tom.userId}`,
      { 'x-household-id': tom.householdId, 'x-user-id': tom.userId },
    );

    expect(await res.json()).toEqual({ done: true, say: `It is on the television now: “Sarah says: ${DOOR_ANSWERS.known}”` });
    expect(patches).toEqual([{ householdId: sarah.householdId, patch: { cardId: 'door-abc', notice: `Sarah says: ${DOOR_ANSWERS.known}` } }]);
    expect(lookRow(table, sarah.householdId)).toMatchObject({ answeredBy: { S: sarah.userId }, answeredByName: { S: 'Sarah' } });
    expect(lookRow(table, tom.householdId)?.answeredAt).toBeUndefined();
  });

  it('answers 400 to a card or an answer that is not one, and 401 to no token — before anything is done', async () => {
    const { h, table, patches } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    askToLook(table, sarah.householdId);

    const badCard = await press(h, token, { cardId: 'door-abc', action: 'known' });
    const badAction = await press(h, token, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'Open the door' });
    const noBody = await tv(h, token, '/tv/press', { method: 'POST' });
    const noToken = await press(h, undefined, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });

    expect([badCard.status, await badCard.json()]).toEqual([400, { error: 'bad_card' }]);
    expect([badAction.status, await badAction.json()]).toEqual([400, { error: 'bad_action' }]);
    expect([noBody.status, await noBody.json()]).toEqual([400, { error: 'bad_card' }]);
    expect([noToken.status, await noToken.json()]).toEqual([401, { error: 'invalid_token' }]);
    expect(patches).toEqual([]);
    expect(lookRow(table, sarah.householdId)?.answeredAt).toBeUndefined();
  });

  it('does nothing for a television that has been revoked or removed', async () => {
    const { h, table, patches } = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    askToLook(table, sarah.householdId);
    const body = { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' };

    // Revoked.
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'FTV#tv-own' }, deviceId: { S: 'tv-own' }, householdId: { S: sarah.householdId }, userId: { S: sarah.userId }, denylisted: { BOOL: true } });
    const revoked = await press(h, token, body);
    // Connected again by somebody else: the old token is not the new owner's.
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'FTV#tv-own' }, deviceId: { S: 'tv-own' }, householdId: { S: sarah.householdId }, userId: { S: 'u_someone_else' }, denylisted: { BOOL: false } });
    const reconnected = await press(h, token, body);

    for (const res of [revoked, reconnected]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'television_not_connected' });
    }
    expect(patches).toEqual([]);
    expect(lookRow(table, sarah.householdId)?.answeredAt).toBeUndefined();
  });
});
