/**
 * Sarah's television, the later slices, end to end over HTTP through the
 * real express app (familyTvApp.ts): her week, a wave, the film seat, and
 * what waits while the app is off the screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  FAMILY_TV_OWN_ACTIONS,
  FAMILY_TV_PRESSES,
  FAMILY_TV_WAITING_SCOPE,
  FAMILY_TV_WAVE_CARD,
  currentIsoWeek,
  familyTvCardId,
  programmeById,
  watchWindow,
  type FamilyTvHome,
  type FamilyTvSeatReply,
  type FamilyTvWaiting,
} from '@wick/contracts';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { markNoteReplied } from '../../../edge-device/lambda/note-reply.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { decisionUpdate, positionUpdate, startUpdate } from '../../../edge-device/lambda/watch-together.mjs';
import { invitationItem } from '../tools/watchSession.js';
import { MIN, askToLook, closeServers, connectTelevision, press, server, tv, type Home } from './familyTvApp.js';
import { linkInvited, linkNewOrganiser, residentAllows, TOM, type Harness, type Linked } from './harness.js';
import type { MemoryTable } from './memoryTable.js';

afterEach(closeServers);

const SINTEL = programmeById('sintel')!;

async function home(): Promise<Home & { sarah: Linked; token: string }> {
  const started = await server();
  const sarah = await linkNewOrganiser(started.h);
  await residentAllows(started.h, sarah.householdId, sarah.userId);
  return { ...started, sarah, token: connectTelevision(started.table, sarah) };
}

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const homeOf = async (h: Harness, token: string): Promise<FamilyTvHome> => json(await tv(h, token, '/tv/home'));

/** A film Sarah asked her to watch, starting now — so the seat can be taken. */
function inviteToWatch(table: MemoryTable, who: Linked, sessionId = 'ws-1'): void {
  const startsAt = Date.now();
  table.put(invitationItem(who.householdId, {
    sessionId,
    programmeId: 'sintel',
    programmeTitle: SINTEL.title,
    startsAt,
    closesAt: watchWindow(startsAt).closesAt,
    invitedBy: who.userId,
    invitedByName: 'Sarah',
    createdAt: startsAt - 60 * MIN,
    status: 'invited',
  }, SINTEL.creditsPositionMs));
}

const edge = (table: MemoryTable, update: unknown): Promise<unknown> => table.ddb.send(new UpdateItemCommand(update as never));
type Build = (input: object) => object;

describe('the new routes', () => {
  it('answer the preflight a browser tab on another origin sends first', async () => {
    const { h } = await home();

    for (const path of ['/tv/seat', '/tv/waiting']) {
      const preflight = await fetch(`${h.base}${path}`, { method: 'OPTIONS', headers: { origin: 'https://ops.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toBe('authorization');
    }
  });

  it('answer 401 with no token and are never kept by a cache', async () => {
    const { h, token } = await home();

    for (const path of ['/tv/seat', '/tv/waiting']) {
      const refused = await tv(h, undefined, path);
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer');
      expect(await refused.json()).toEqual({ error: 'invalid_token' });

      const answered = await tv(h, token, path, { headers: { origin: 'https://ops.example' } });
      expect(answered.status).toBe(200);
      expect(answered.headers.get('cache-control')).toBe('no-store');
      expect(answered.headers.get('access-control-allow-origin')).toBe('*');
    }
  });

  it('INV-8: read nothing that names a household or a member — the seat and what waits are the token’s', async () => {
    const { h, table, sarah, token } = await home();
    const tom = await linkNewOrganiser(h, TOM, 'Edith');
    await residentAllows(h, tom.householdId, tom.userId);
    askToLook(table, tom.householdId, 'door-edith');
    inviteToWatch(table, tom, 'ws-edith');
    await edge(table, (decisionUpdate as Build)({ table: 'wick', householdId: tom.householdId, sessionId: 'ws-edith', accepted: true, at: Date.now() }));
    const naming = `?householdId=${tom.householdId}&userId=${tom.userId}&deviceId=tv-tom&sessionId=ws-edith`;
    const headers = { 'x-household-id': tom.householdId, 'x-user-id': tom.userId };

    const waiting = await json<FamilyTvWaiting>(await tv(h, token, `/tv/waiting${naming}`, { headers }));
    const seat = await json<FamilyTvSeatReply>(await tv(h, token, `/tv/seat${naming}`, { headers }));

    expect(waiting).toEqual({ waiting: [] });
    expect(seat).toEqual({});
    expect(sarah.householdId).not.toBe(tom.householdId);
  });

  it('refuse a member she has not allowed, a neighbour, and a television that is no longer connected', async () => {
    const { h, table, sarah, token } = await home();
    const invitation = await json<{ code: string }>(await fetch(`${h.base}/api/circle/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sarah.tokens.access_token}` },
      body: JSON.stringify({ role: 'neighbour' }),
    }));
    const tom = await linkInvited(h, TOM, invitation.code);
    const toms = connectTelevision(table, tom, 'tv-tom');
    askToLook(table, sarah.householdId);

    for (const path of ['/tv/seat', '/tv/waiting']) {
      const waiting = await tv(h, toms, path);
      expect(waiting.status).toBe(403);
      expect(await waiting.json()).toEqual({ error: 'not_allowed', say: 'Margaret hasn’t allowed this yet. A card is waiting on the television, and it only takes one press.' });
    }

    await residentAllows(h, tom.householdId, tom.userId);
    for (const path of ['/tv/seat', '/tv/waiting', '/tv/home']) {
      const neighbour = await tv(h, toms, path);
      expect(neighbour.status).toBe(403);
      expect(await neighbour.json()).toMatchObject({ error: 'not_allowed', say: expect.stringContaining('Nothing else about the house is shared with a neighbour.') as unknown });
    }

    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'FTV#tv-own' }, deviceId: { S: 'tv-own' }, householdId: { S: sarah.householdId }, userId: { S: sarah.userId }, denylisted: { BOOL: true } });
    for (const path of ['/tv/seat', '/tv/waiting']) {
      const revoked = await tv(h, token, path);
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toEqual({ error: 'television_not_connected' });
    }
  });
});

describe('her week, on the member’s television', () => {
  it('is offered once she has read it, read a page at a time, and put away on this television when read', async () => {
    const clock = { now: Date.now() };
    // Not across the turn of a week: the week is looked up afresh then, and this is about the minute in between.
    if (currentIsoWeek(new Date(clock.now)) !== currentIsoWeek(new Date(clock.now + 60_000))) clock.now += 60_000;
    const { h, table } = await server({ now: () => clock.now });
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const token = connectTelevision(table, sarah);
    const isoWeek = currentIsoWeek(new Date(clock.now));
    const week = (seen: boolean) =>
      table.put({
        pk: { S: `HH#${sarah.householdId}` },
        sk: { S: `NARR#${isoWeek}` },
        data: { S: JSON.stringify({ householdId: sarah.householdId, isoWeek, text: 'A quiet week. Maria came twice.', deltas: [], timeline: [], generatedAt: Date.now(), ...(seen ? { residentSeenAt: Date.now() } : {}) }) },
      });

    week(false);
    expect((await homeOf(h, token)).cards).toEqual([]);

    // She reads it on her own television. This one looks her weeks up once a minute, and offers it then.
    week(true);
    clock.now += 30_000;
    expect((await homeOf(h, token)).cards).toEqual([]);
    clock.now += 30_000;
    const cards = (await homeOf(h, token)).cards;
    expect(cards).toMatchObject([
      {
        id: familyTvCardId('week', isoWeek),
        kind: 'week',
        headline: 'Margaret’s week is here to read.',
        pages: ['A quiet week. Maria came twice.'],
        actions: [{ id: FAMILY_TV_OWN_ACTIONS.read }, { id: FAMILY_TV_OWN_ACTIONS.later }],
      },
    ]);

    const read = await press(h, token, { cardId: cards[0]!.id, action: FAMILY_TV_PRESSES.read });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ done: true, say: 'You have read Margaret’s week.' });
    expect((await homeOf(h, token)).cards).toEqual([]);
  });
});

describe('a wave, there and back', () => {
  it('goes to her television as one card through the server’s sender, and her wave back is shown here until seen', async () => {
    const { h, table, sarah, token, withdrawn } = await home();
    expect((await homeOf(h, token)).wave).toEqual({ label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD });
    const sentBefore = h.cards.length;

    const sent = await press(h, token, { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave, name: 'Tom', message: 'Open the door' });

    expect(await sent.json()).toEqual({ done: true, say: 'Your wave is on its way to Margaret’s television. It will wait for a quiet moment.' });
    const [card] = h.cards.slice(sentBefore);
    expect(h.cards.slice(sentBefore)).toHaveLength(1);
    expect(card).toMatchObject({
      urgency: 'DEFERRED',
      card: { type: 'MESSAGE', householdId: sarah.householdId, fromName: 'Sarah', transcript: 'A wave to you from Sarah’s television.', suggestedReplies: ['Wave back', 'Not now'] },
    });
    expect((await homeOf(h, token)).wave).toEqual({ label: 'Wave to Margaret', line: 'Your wave is on its way to Margaret’s television.' });
    const again = await press(h, token, { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave });
    expect(await again.json()).toMatchObject({ done: false });
    expect(h.cards.slice(sentBefore)).toHaveLength(1);
    expect(withdrawn).toEqual([]);

    // Her television: the card as egress keeps it, and her press on "Wave back" as the edge keeps that.
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: `CARD#${card!.id}` }, data: { S: JSON.stringify(card) } });
    await edge(table, (markNoteReplied as Build)({ table: 'wick', householdId: sarah.householdId, cardId: card!.id, text: 'Wave back', at: Date.now() }));

    const back = await homeOf(h, token);
    expect(back.cards).toMatchObject([{ kind: 'wave', headline: 'Margaret waved back.', actions: [{ id: FAMILY_TV_PRESSES.seen, label: 'All right', kind: 'primary' }] }]);
    expect(back.wave).toEqual({ label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD });

    const seen = await press(h, token, { cardId: back.cards[0]!.id, action: FAMILY_TV_PRESSES.seen });
    expect(await seen.json()).toEqual({ done: true, say: 'Margaret waved back.' });
    expect((await homeOf(h, token)).cards).toEqual([]);
  });

  it('is not a note to anybody asking what she replied: get_replies’ own reader does not list it', async () => {
    const { h, table, sarah, token } = await home();
    await press(h, token, { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave });
    const card = h.cards.at(-1)!;
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
    await edge(table, (markNoteReplied as Build)({ table: 'wick', householdId: sarah.householdId, cardId: card.id, text: 'Wave back', at: Date.now() }));

    const { loadNoteReplies } = await import('../tools/get_replies.js');

    expect(await loadNoteReplies(table.ddb, sarah.householdId, sarah.userId, Date.now())).toEqual([]);
  });
});

describe('the film seat', () => {
  it('sits the member down, follows her film from her own press, and is nobody else’s', async () => {
    const { h, table, sarah, token } = await home();
    inviteToWatch(table, sarah);
    const target = { table: 'wick', householdId: sarah.householdId, sessionId: 'ws-1' };
    await edge(table, (decisionUpdate as Build)({ ...target, accepted: true, at: Date.now() }));
    const cardId = familyTvCardId('watch', 'ws-1');

    expect(await json(await tv(h, token, '/tv/seat'))).toEqual({});
    expect((await homeOf(h, token)).cards).toMatchObject([{ id: cardId, kind: 'watch', actions: [{ id: FAMILY_TV_PRESSES.sit, label: 'Sit down' }, { id: FAMILY_TV_OWN_ACTIONS.later }] }]);

    const sentBefore = h.cards.length;
    const sat = await press(h, token, { cardId, action: FAMILY_TV_PRESSES.sit });
    expect(await sat.json()).toEqual({ done: true, say: 'You have sat down. Margaret’s television says you are ready.' });
    expect(h.cards.slice(sentBefore).map((queued) => queued.card)).toMatchObject([{ type: 'WATCH', headline: 'Sarah is ready to watch Sintel with you.' }]);
    expect(await json<FamilyTvSeatReply>(await tv(h, token, '/tv/seat'))).toMatchObject({ seat: { cardId, film: 'Sintel', state: 'waiting', line: 'Waiting for Margaret to start the film.' } });

    await edge(table, (startUpdate as Build)({ ...target, at: Date.now() }));
    await edge(table, (positionUpdate as Build)({ table: 'wick', householdId: sarah.householdId, event: { t: 'watch_position', sessionId: 'ws-1', state: 'PLAYING', positionMs: 42_000, contentId: 'sintel', at: Date.now() }, now: Date.now() }));

    const { seat } = await json<FamilyTvSeatReply>(await tv(h, token, '/tv/seat'));
    expect(seat).toMatchObject({ state: 'watching', line: 'You are watching Sintel with Margaret.', playback: { state: 'PLAYING', positionMs: 42_000 } });
    expect(seat!.stream!.url).toMatch(/\/sintel\/index\.m3u8$/);

    // Another member of the same circle, with a television of his own: no card, an empty seat, and no way to sit down.
    const invitation = await json<{ code: string }>(await fetch(`${h.base}/api/circle/invitations`, { method: 'POST', headers: { authorization: `Bearer ${sarah.tokens.access_token}` } }));
    const tom = await linkInvited(h, TOM, invitation.code);
    await residentAllows(h, tom.householdId, tom.userId);
    const toms = connectTelevision(table, tom, 'tv-tom');

    expect(await json(await tv(h, toms, '/tv/seat'))).toEqual({});
    expect((await homeOf(h, toms)).cards).toEqual([]);
    expect(await json(await press(h, toms, { cardId, action: FAMILY_TV_PRESSES.sit }))).toEqual({ done: false, say: "You haven't asked Margaret to watch anything." });
    expect(JSON.stringify(await homeOf(h, toms))).not.toMatch(/Sintel|film/i);
  });
});

describe('what waits while the app is off the screen', () => {
  it('is told to the background service’s own token, which opens nothing else', async () => {
    const { h, table, sarah, token, homes, patches } = await home();
    const service = connectTelevision(table, sarah, 'tv-own', { scope: FAMILY_TV_WAITING_SCOPE, since: Date.now() - 60_000 });
    askToLook(table, sarah.householdId);

    const waiting = await tv(h, service, '/tv/waiting');
    expect(waiting.status).toBe(200);
    expect(await waiting.json()).toEqual({ waiting: [{ id: 'ftv-door_look-door-abc', line: 'Margaret has asked you to look at the door.' }] });
    // Nobody looked: she is told of no look, however often the service asks.
    for (let i = 0; i < 5; i += 1) await tv(h, service, '/tv/waiting');
    expect(homes).toEqual([]);

    for (const refused of [
      await tv(h, service, '/tv/home'),
      await tv(h, service, '/tv/seat'),
      await press(h, service, { cardId: 'ftv-door_look-door-abc', action: 'known' }),
    ]) {
      expect(refused.status).toBe(401);
      expect(refused.headers.get('www-authenticate')).toBe('Bearer');
      expect(await refused.json()).toEqual({ error: 'wrong_scope' });
    }
    expect(patches).toEqual([]);

    // A new hand-off to the service ends the earlier chain at once.
    table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'FTV#tv-own' }, deviceId: { S: 'tv-own' }, householdId: { S: sarah.householdId }, userId: { S: sarah.userId }, denylisted: { BOOL: false }, serviceSince: { N: String(Date.now()) } });
    const over = await tv(h, service, '/tv/waiting');
    expect(over.status).toBe(401);
    expect(over.headers.get('www-authenticate')).toBe('Bearer');
    expect(await over.json()).toEqual({ error: 'session_over' });

    // The television's ordinary token is taken too.
    expect((await json<FamilyTvWaiting>(await tv(h, token, '/tv/waiting'))).waiting).toHaveLength(1);
  });

  it('says nothing while the app itself is on screen, and says it again twenty seconds after the app last asked', async () => {
    const clock = { now: Date.now() };
    const started = await server({ now: () => clock.now });
    const sarah = await linkNewOrganiser(started.h);
    await residentAllows(started.h, sarah.householdId, sarah.userId);
    const token = connectTelevision(started.table, sarah);
    const service = connectTelevision(started.table, sarah, 'tv-own', { scope: FAMILY_TV_WAITING_SCOPE, since: clock.now - 60_000 });
    askToLook(started.table, sarah.householdId);

    expect((await homeOf(started.h, token)).cards).toHaveLength(1);

    clock.now += 19_999;
    expect(await json(await tv(started.h, service, '/tv/waiting'))).toEqual({ waiting: [] });
    clock.now += 1;
    expect((await json<FamilyTvWaiting>(await tv(started.h, service, '/tv/waiting'))).waiting).toHaveLength(1);
  });
});
