/**
 * Sarah's television, off the screen: what its background service is told
 * is waiting (`GET /tv/waiting`), the narrower token that service holds,
 * and the silence kept while the app itself is on screen.
 */
import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { FAMILY_TV_PRESSES, FAMILY_TV_WAITING_SCOPE, FAMILY_TV_WAVE_CARD, WATCH_OPENS_BEFORE_MS, familyTvCardId, programmeById, watchWindow, type FamilyTvWaiting, type QueuedCard } from '@wick/contracts';
import { reachItem } from '@wick/agent';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { markNoteReplied } from '../../../../edge-device/lambda/note-reply.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { decisionUpdate } from '../../../../edge-device/lambda/watch-together.mjs';
import { ON_SCREEN_FOR_MS } from '../familyTelevision.js';
import { invitationItem } from '../../tools/watchSession.js';
import {
  HOUR,
  MIN,
  NOW,
  PICTURE,
  REACH_ID,
  SARAHS_TV,
  STRANGER,
  bearer,
  david,
  homeOf,
  householdRequests,
  keepsRhythmPrivate,
  litToday,
  lookInRow,
  putDoorCard,
  putFamilyTv,
  putLook,
  reach,
  sarah,
  token,
  world,
  type World,
} from './familyTvWorld.js';

const SUNDAY_AT_THREE = Date.UTC(2026, 9, 18, 14, 0);
const OPENS = SUNDAY_AT_THREE - WATCH_OPENS_BEFORE_MS;
const SINTEL = programmeById('sintel')!;

/** The token the television's background service holds: the same television, good for one thing. */
const SERVICE = bearer(token({ ...SARAHS_TV, scope: FAMILY_TV_WAITING_SCOPE }));

const waitingOf = async (w: World, authorization: string = SERVICE): Promise<FamilyTvWaiting> => {
  const reply = await w.tv.waiting(authorization);
  expect(reply.status).toBe(200);
  return reply.body as FamilyTvWaiting;
};

const doorIsAsked = (w: World): void => {
  putDoorCard(w.table, 'door-abc', { description: 'A man in a yellow jacket.', imageRef: PICTURE });
  putLook(w.table, 'door-abc', NOW - 30_000);
};

/** A film she has said yes to, for Sunday at three. */
async function filmAccepted(w: World): Promise<void> {
  const session = { sessionId: 'ws-1', programmeId: 'sintel', programmeTitle: SINTEL.title, startsAt: SUNDAY_AT_THREE, closesAt: watchWindow(SUNDAY_AT_THREE).closesAt, invitedBy: 'u_sarah', invitedByName: 'Sarah', createdAt: NOW - HOUR, status: 'invited' as const };
  w.table.put(invitationItem('hh-1', session, SINTEL.creditsPositionMs));
  await w.table.ddb.send(new UpdateItemCommand((decisionUpdate as (i: object) => object)({ table: 'wick', householdId: 'hh-1', sessionId: 'ws-1', accepted: true, at: NOW }) as never));
}

/** Sarah waves, the card reaches her television, and she presses “Wave back”. */
async function waveComesBack(w: World): Promise<void> {
  await w.tv.press(bearer(), { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave });
  const card: QueuedCard = w.cards.at(-1)!;
  w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
  await w.table.ddb.send(new UpdateItemCommand((markNoteReplied as (i: object) => object)({ table: 'wick', householdId: 'hh-1', cardId: card.id, text: 'Wave back', at: w.clock }) as never));
}

describe('GET /tv/waiting', () => {
  it('is empty when nothing waits', async () => {
    expect(await waitingOf(await world())).toEqual({ waiting: [] });
  });

  it('says her question from the door in one sentence, and never the picture or what it shows', async () => {
    const w = await world();
    doorIsAsked(w);

    const waiting = await waitingOf(w);

    expect(waiting).toEqual({ waiting: [{ id: 'ftv-door_look-door-abc', line: 'Margaret has asked you to look at the door.' }] });
    expect(JSON.stringify(waiting)).not.toMatch(/yellow jacket|download\.example/);
  });

  it('says she would like to be rung to the person she asked, and nothing to anyone not asked', async () => {
    const asked = await world();
    asked.table.put(reachItem(reach()));
    const notAsked = await world();
    notAsked.table.put(reachItem(reach({ order: [david, sarah], asked: 1 })));

    expect(await waitingOf(asked)).toEqual({ waiting: [{ id: `ftv-reach-${REACH_ID}`, line: 'Margaret would like you to ring her.' }] });
    expect(JSON.stringify(await waitingOf(notAsked))).toBe(JSON.stringify(await waitingOf(await world())));
  });

  it('says a film is ready to be sat down to from half an hour before, and not once the member has', async () => {
    const w = await world();
    await filmAccepted(w);

    w.clock = OPENS - 1;
    expect(await waitingOf(w)).toEqual({ waiting: [] });

    w.clock = OPENS;
    expect(await waitingOf(w)).toEqual({ waiting: [{ id: 'ftv-watch-ws-1', line: 'Sintel with Margaret, Sunday 18 October at 3 pm.' }] });

    await w.tv.press(bearer(), { cardId: familyTvCardId('watch', 'ws-1'), action: FAMILY_TV_PRESSES.sit });
    expect(await waitingOf(w)).toEqual({ waiting: [] });
  });

  it('says a wave has come back, until it has been seen', async () => {
    const w = await world();
    await waveComesBack(w);
    const id = familyTvCardId('wave', String(NOW));

    expect(await waitingOf(w)).toEqual({ waiting: [{ id, line: 'Margaret waved back.' }] });

    await w.tv.press(bearer(), { cardId: id, action: FAMILY_TV_PRESSES.seen });
    expect(await waitingOf(w)).toEqual({ waiting: [] });
  });

  it('leaves out what is settled: somebody else’s answer is on the home screen, not in what waits', async () => {
    const w = await world();
    putDoorCard(w.table, 'door-abc');
    putLook(w.table, 'door-abc', NOW - 5 * MIN, { answerKey: { S: 'known' }, answeredAt: { N: String(NOW - MIN) }, answeredBy: { S: 'u_david' }, answeredByName: { S: 'David' } });

    expect(await waitingOf(w)).toEqual({ waiting: [] });
    expect((await homeOf(w)).cards).toHaveLength(1);
  });

  it('puts the door first, then her asking to be rung, then the film — and never more than three', async () => {
    const w = await world();
    doorIsAsked(w);
    w.table.put(reachItem(reach()));
    await filmAccepted(w);
    await waveComesBack(w);
    w.clock = OPENS;
    // The door and the request as they would stand at that later moment.
    putDoorCard(w.table, 'door-abc', {}, OPENS + 4 * MIN);
    putLook(w.table, 'door-abc', OPENS - 30_000);
    w.table.put(reachItem(reach({ reachId: String(OPENS - MIN), askedAt: OPENS - MIN })));

    expect((await waitingOf(w)).waiting.map((entry) => entry.id.split('-')[1])).toEqual(['door_look', 'reach', 'watch']);
  });

  it('is not a look: nothing of her day is read, nobody is told, and nothing is written', async () => {
    const w = await world();
    litToday(w.table);
    doorIsAsked(w);
    w.table.put(reachItem(reach()));
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'NARR#2026-W41' }, data: { S: JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W41', text: 'A quiet week.', deltas: [], timeline: [], generatedAt: NOW, residentSeenAt: NOW }) } });

    for (let i = 0; i < 20; i += 1) {
      const waiting = await waitingOf(w);
      expect(JSON.stringify(waiting)).not.toMatch(/light|week|lit/i);
      w.clock += 20_000;
    }

    const made = householdRequests(w);
    expect(made.every((r) => r.command === 'GetItemCommand' || r.command === 'QueryCommand')).toBe(true);
    expect(made.some((r) => r.sk === 'META' || r.sk === 'LIGHT' || r.sk.startsWith('DEV#') || r.sk.startsWith('NARR#') || r.sk.startsWith('LOOKIN#'))).toBe(false);
    expect(made.every((r) => r.pk === 'HH#hh-1')).toBe(true);
    expect(lookInRow(w.table)).toBeUndefined();
    expect(w.homes).toEqual([]);
    expect(w.cards).toEqual([]);
    expect(w.patches).toEqual([]);
  });

  it('is a handful of reads: its own row, the door, her asking, the films and the wave', async () => {
    const w = await world();

    await waitingOf(w);

    expect(householdRequests(w).map((r) => `${r.command} ${r.sk}`)).toEqual(
      expect.arrayContaining(['GetItemCommand FTV#tv-sarah', 'QueryCommand LOOK#', 'QueryCommand REACH#', 'QueryCommand WATCH#', 'GetItemCommand WAVE#u_sarah']),
    );
    expect(householdRequests(w)).toHaveLength(5);
  });

  it('answers nobody the resident does not allow, and no neighbour — on this route or the seat’s', async () => {
    const pending = await world({ sarah: { status: 'pending' } });
    const neighbour = await world({ sarah: { role: 'neighbour' } });
    for (const w of [pending, neighbour]) {
      doorIsAsked(w);
      w.table.put(reachItem(reach()));
      for (const authorization of [SERVICE, bearer()]) {
        const waiting = await w.tv.waiting(authorization);
        expect(waiting).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
        expect(JSON.stringify(waiting.body)).not.toMatch(/asked you to look|would like you to ring/);
      }
      expect(await w.tv.seat(bearer())).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
      // Their own row, to know who is asking, and nothing else of the household's.
      expect(householdRequests(w).every((r) => r.sk === 'FTV#tv-sarah')).toBe(true);
    }
    expect(await neighbour.tv.waiting(SERVICE)).toMatchObject({ reason: 'neighbour' });
  });

  it('answers 401 to no token and to one nobody signed, and reads nothing', async () => {
    const w = await world();
    doorIsAsked(w);

    for (const authorization of [undefined, 'Bearer nonsense', bearer(token({ ...SARAHS_TV, scope: FAMILY_TV_WAITING_SCOPE }, { signedWith: STRANGER.privateKey }))]) {
      expect(await w.tv.waiting(authorization)).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
      expect(await w.tv.seat(authorization)).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    }
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
  });
});

describe('the background service’s token (scope: waiting)', () => {
  it('is taken by /tv/waiting, as the television’s ordinary token is', async () => {
    const w = await world();
    doorIsAsked(w);

    expect((await waitingOf(w, SERVICE)).waiting).toHaveLength(1);
    expect((await waitingOf(w, bearer())).waiting).toHaveLength(1);
  });

  it('is refused by the home screen, a press and the seat — and nothing is read or done for it', async () => {
    const w = await world();
    litToday(w.table);
    doorIsAsked(w);

    const home = await w.tv.home(SERVICE);
    const press = await w.tv.press(SERVICE, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' });
    const wave = await w.tv.press(SERVICE, { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave });
    const seat = await w.tv.seat(SERVICE);

    for (const reply of [home, press, wave, seat]) expect(reply).toEqual({ status: 401, body: { error: 'wrong_scope' }, reason: 'wrong_scope' });
    expect(householdRequests(w)).toEqual([]);
    expect(w.storeCalls).toEqual([]);
    expect(w.patches).toEqual([]);
    expect(w.cards).toEqual([]);
    expect(lookInRow(w.table)).toBeUndefined();
  });

  it.each([
    ['another scope', 'home'],
    ['every scope at once', '*'],
    ['the scope in another case', 'WAITING'],
    ['an empty scope', ''],
    ['a scope that is nothing', null],
    ['a list of scopes', ['waiting']],
    ['a scope that is a yes', true],
  ])('is refused everywhere when it carries %s', async (_name, scope) => {
    const w = await world();
    doorIsAsked(w);
    const odd = bearer(token({ ...SARAHS_TV, scope }));

    for (const reply of [await w.tv.waiting(odd), await w.tv.home(odd), await w.tv.seat(odd), await w.tv.press(odd, { cardId: familyTvCardId('door_look', 'door-abc'), action: 'known' })]) {
      expect(reply).toEqual({ status: 401, body: { error: 'wrong_scope' }, reason: 'wrong_scope' });
    }
    expect(householdRequests(w)).toEqual([]);
    expect(w.patches).toEqual([]);
  });

  it('is held to every other check the ordinary token is', async () => {
    const removed = await world({ familyTv: false });
    const revoked = await world({ familyTv: false });
    putFamilyTv(revoked.table, { denylisted: true });
    const anothers = await world({ familyTv: false });
    putFamilyTv(anothers.table, { userId: 'u_david' });

    expect(await removed.tv.waiting(SERVICE)).toMatchObject({ status: 401, body: { error: 'television_not_connected' }, reason: 'no_row' });
    expect(await revoked.tv.waiting(SERVICE)).toMatchObject({ status: 401, reason: 'denylisted' });
    expect(await anothers.tv.waiting(SERVICE)).toMatchObject({ status: 401, reason: 'not_this_members' });

    const w = await world();
    const expired = bearer(token({ ...SARAHS_TV, scope: FAMILY_TV_WAITING_SCOPE }, { exp: Math.floor(NOW / 1000) - 1 }));
    const unsignedAlg = bearer(token({ ...SARAHS_TV, scope: FAMILY_TV_WAITING_SCOPE }, { header: { alg: 'none' }, signature: 'none' }));
    const residents = bearer(token({ deviceId: 'wick-tv', householdId: 'hh-1', scope: FAMILY_TV_WAITING_SCOPE }));
    expect(await w.tv.waiting(expired)).toMatchObject({ status: 401, reason: 'expired' });
    expect(await w.tv.waiting(unsignedAlg)).toMatchObject({ status: 401, reason: 'bad_alg' });
    expect(await w.tv.waiting(residents)).toMatchObject({ status: 403, reason: 'not_family' });

    await w.store.setMemberStatus('hh-1', 'u_sarah', 'removed', NOW);
    expect(await w.tv.waiting(SERVICE)).toMatchObject({ status: 403, reason: 'not_allowed' });
  });
});

describe('nothing to say while the app is on screen', () => {
  it('answers that nothing waits for twenty seconds after the television asked for its home, and says what does from then on', async () => {
    const w = await world();
    doorIsAsked(w);
    await homeOf(w);
    const from = householdRequests(w).length;

    w.clock = NOW + ON_SCREEN_FOR_MS - 1;
    expect(await waitingOf(w)).toEqual({ waiting: [] });
    // Known from memory alone: beyond knowing who is asking, the household is not read for it.
    expect(householdRequests(w).slice(from).map((r) => r.sk)).toEqual(['FTV#tv-sarah']);

    w.clock = NOW + ON_SCREEN_FOR_MS;
    expect(await waitingOf(w)).toEqual({ waiting: [{ id: 'ftv-door_look-door-abc', line: 'Margaret has asked you to look at the door.' }] });
  });

  it('is twenty seconds, the time between two of the service’s askings', () => {
    expect(ON_SCREEN_FOR_MS).toBe(20_000);
  });

  it('goes on being silent for as long as the app goes on asking', async () => {
    const w = await world();
    doorIsAsked(w);

    for (let i = 0; i < 10; i += 1) {
      await homeOf(w);
      w.clock += 8_000;
      expect(await waitingOf(w)).toEqual({ waiting: [] });
    }
  });

  it('is each television’s own: another of the member’s televisions, off the screen, is still told', async () => {
    const w = await world();
    doorIsAsked(w);
    putFamilyTv(w.table, { deviceId: 'tv-kitchen' });
    const kitchen = bearer(token({ deviceId: 'tv-kitchen', householdId: 'hh-1', kind: 'family', userId: 'u_sarah', scope: FAMILY_TV_WAITING_SCOPE }));

    await homeOf(w);

    expect(await waitingOf(w, SERVICE)).toEqual({ waiting: [] });
    expect((await waitingOf(w, kitchen)).waiting).toHaveLength(1);
  });

  it('is not begun by a home screen that was refused', async () => {
    const w = await world();
    doorIsAsked(w);

    expect((await w.tv.home(SERVICE)).status).toBe(401);
    expect((await w.tv.home(bearer(token(SARAHS_TV, { signedWith: STRANGER.privateKey })))).status).toBe(401);

    expect((await waitingOf(w)).waiting).toHaveLength(1);
  });

  it('is not begun by a home screen that could not be answered: an app showing nothing is not saying it itself', async () => {
    const w = await world();
    doorIsAsked(w);
    let failing = true;
    w.before((request) => {
      if (failing && request.sk === 'REACH#') throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    });

    await expect(w.tv.home(bearer())).rejects.toThrow('throttled');
    failing = false;

    expect((await waitingOf(w)).waiting).toHaveLength(1);
  });

  it('is not begun by a press, the seat or an asking of what waits', async () => {
    const w = await world();
    doorIsAsked(w);

    await w.tv.seat(bearer());
    await w.tv.waiting(bearer());
    await w.tv.press(bearer(), { cardId: 'ftv-week-2026-W30', action: FAMILY_TV_PRESSES.read });

    expect((await waitingOf(w)).waiting).toHaveLength(1);
  });

  it('still refuses whoever it would refuse: silence is not an answer for someone not allowed', async () => {
    const w = await world();
    await homeOf(w);
    await w.store.setMemberStatus('hh-1', 'u_sarah', 'removed', NOW);

    expect((await w.tv.waiting(SERVICE)).status).toBe(403);
  });

  it('says nothing about her day either way: with her week private the answers are the same', async () => {
    const w = await world();
    keepsRhythmPrivate(w.table);
    doorIsAsked(w);

    expect((await waitingOf(w)).waiting).toHaveLength(1);
  });
});
