/**
 * Sarah's television, the film seat: the card for a film she arranged with
 * the resident, sitting down to it, the seat beside the film, and the one
 * question at the end. The resident's half is the edge's own updates, run
 * as they are deployed (edge-device watch-together.mjs).
 */
import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  FAMILY_TV_OWN_ACTIONS,
  FAMILY_TV_PRESSES,
  WATCH_ANSWERS,
  WATCH_OPENS_BEFORE_MS,
  WATCH_QUESTION,
  familyTvCardId,
  programmeById,
  watchCardId,
  watchWindow,
  type FamilyTvSeatReply,
} from '@wick/contracts';
import {
  answerUpdate,
  askedUpdate,
  decisionUpdate,
  notNowUpdate,
  positionUpdate,
  startUpdate,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../../../../edge-device/lambda/watch-together.mjs';
import type { MemoryTable } from '../../__tests__/memoryTable.js';
import { describeWatch, invitationItem, readSession, type WatchSession } from '../../tools/watchSession.js';
import { MIN, NOW, bearer, homeOf, householdRequests, lookInRow, member, putFamilyTv, token, world, type World } from './familyTvWorld.js';

/** Sunday 18 October 2026, 15:00 in London. */
const SUNDAY_AT_THREE = Date.UTC(2026, 9, 18, 14, 0);
const OPENS = SUNDAY_AT_THREE - WATCH_OPENS_BEFORE_MS;
const CLOSES = watchWindow(SUNDAY_AT_THREE).closesAt;
const SINTEL = programmeById('sintel')!;
const CARD = familyTvCardId('watch', 'ws-1');

const SIT = { id: FAMILY_TV_PRESSES.sit, label: 'Sit down', kind: 'primary' };
const SEAT = { id: FAMILY_TV_OWN_ACTIONS.seat, label: 'Take your seat', kind: 'primary' };
const LATER = { id: FAMILY_TV_OWN_ACTIONS.later, label: 'Not now', kind: 'dismiss' };

/** An invitation as invite_to_watch files it. */
function invite(table: MemoryTable, over: Partial<WatchSession> = {}): void {
  const startsAt = over.startsAt ?? SUNDAY_AT_THREE;
  const session: WatchSession = {
    sessionId: 'ws-1',
    programmeId: 'sintel',
    programmeTitle: SINTEL.title,
    startsAt,
    closesAt: watchWindow(startsAt).closesAt,
    invitedBy: 'u_sarah',
    invitedByName: 'Sarah',
    createdAt: NOW - 60 * MIN,
    status: 'invited',
    ...over,
  };
  table.put(invitationItem('hh-1', session, SINTEL.creditsPositionMs));
}

/** Margaret's television, as the edge hears it. */
function hers(table: MemoryTable, sessionId = 'ws-1') {
  const target = { table: 'wick', householdId: 'hh-1', sessionId };
  const apply = async (update: object | undefined): Promise<void> => {
    if (!update) return;
    try {
      await table.ddb.send(new UpdateItemCommand(update as never));
    } catch (err) {
      if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
    }
  };
  type Build = (input: object) => object | undefined;
  return {
    accepts: (at: number) => apply((decisionUpdate as Build)({ ...target, accepted: true, at })),
    declines: (at: number) => apply((decisionUpdate as Build)({ ...target, accepted: false, at })),
    starts: (at: number) => apply((startUpdate as Build)({ ...target, at })),
    saysNotNow: (at: number) => apply((notNowUpdate as Build)({ ...target, at })),
    plays: (state: string, positionMs: number, now: number) =>
      apply((positionUpdate as Build)({ table: 'wick', householdId: 'hh-1', event: { t: 'watch_position', sessionId, state, positionMs, contentId: 'sintel', at: now }, now })),
    isAsked: (at: number) => apply((askedUpdate as Build)({ ...target, at })),
    answers: (answer: string, at: number) => apply((answerUpdate as Build)({ ...target, answer, at })),
  };
}

const session = (table: MemoryTable, sessionId = 'ws-1'): WatchSession | undefined => readSession(table.rows('HH#hh-1').find((row) => row.sk?.S === `WATCH#${sessionId}`));
const watchCardOf = async (w: World, authorization?: string) => (await homeOf(w, authorization)).cards.filter((card) => card.kind === 'watch');
const seatOf = async (w: World, authorization: string = bearer()): Promise<FamilyTvSeatReply> => {
  const reply = await w.tv.seat(authorization);
  expect(reply.status).toBe(200);
  return reply.body as FamilyTvSeatReply;
};
const press = (w: World, action: string, cardId = CARD, authorization = bearer()) => w.tv.press(authorization, { cardId, action });

/** A home where she has said yes, at a moment of the test's choosing. */
async function accepted(at: number = OPENS): Promise<World> {
  const w = await world();
  invite(w.table);
  await hers(w.table).accepts(NOW);
  w.clock = at;
  return w;
}

/** … and Sarah has sat down on her television. */
async function seated(at: number = OPENS): Promise<World> {
  const w = await accepted(at);
  expect((await press(w, FAMILY_TV_PRESSES.sit)).body).toMatchObject({ done: true });
  return w;
}

/** A second member with a television of his own. */
async function withDavid(w: World): Promise<string> {
  await w.store.putMembership(member({ userId: 'u_david', name: 'David', role: 'family' }));
  putFamilyTv(w.table, { deviceId: 'tv-david', userId: 'u_david' });
  return bearer(token({ deviceId: 'tv-david', householdId: 'hh-1', kind: 'family', userId: 'u_david' }));
}

describe('GET /tv/home — a film arranged with her', () => {
  it('says nothing while she has not answered, when she said no, and when there is no film', async () => {
    const none = await world();
    const invited = await world();
    invite(invited.table);
    const declined = await world();
    invite(declined.table);
    await hers(declined.table).declines(NOW);

    for (const w of [none, invited, declined]) expect(await watchCardOf(w)).toEqual([]);
  });

  it('says when it is, with nothing to press, until half an hour before', async () => {
    const w = await accepted(OPENS - 1);

    expect(await watchCardOf(w)).toEqual([
      { id: CARD, kind: 'watch', headline: 'Sintel with Margaret, Sunday 18 October at 3 pm.', detail: 'You can sit down here from half an hour before.', actions: [] },
    ]);
  });

  it('offers the seat from half an hour before', async () => {
    const w = await accepted(OPENS);

    expect(await watchCardOf(w)).toEqual([
      {
        id: CARD,
        kind: 'watch',
        headline: 'Sintel with Margaret, Sunday 18 October at 3 pm.',
        detail: 'You can sit down now. Margaret’s television will say you are ready.',
        actions: [SIT, LATER],
      },
    ]);
  });

  it('offers the way back to the seat once sat down, and says how the film stands', async () => {
    const w = await seated();
    expect(await watchCardOf(w)).toEqual([{ id: CARD, kind: 'watch', headline: 'Waiting for Margaret to start Sintel.', actions: [SEAT, LATER] }]);

    await hers(w.table).starts(OPENS + MIN);
    w.clock = OPENS + 2 * MIN;
    expect(await watchCardOf(w)).toEqual([{ id: CARD, kind: 'watch', headline: 'Margaret has started Sintel.', actions: [SEAT, LATER] }]);

    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    expect(await watchCardOf(w)).toEqual([{ id: CARD, kind: 'watch', headline: 'Sintel has ended. There is one question for you.', actions: [SEAT, LATER] }]);
  });

  it('keeps what each of them said about the film, with nothing to press, for as long as the invitation’s window is open', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    await press(w, 'loved_it');

    expect(await watchCardOf(w)).toEqual([{ id: CARD, kind: 'watch', headline: `Sintel. You said: “${WATCH_ANSWERS.loved_it}” Margaret has not answered yet.`, actions: [] }]);

    await hers(w.table).answers('all_right', OPENS + 22 * MIN);
    w.clock = CLOSES - 1;
    expect(await watchCardOf(w)).toEqual([{ id: CARD, kind: 'watch', headline: `Sintel. You said: “${WATCH_ANSWERS.loved_it}” Margaret said: “${WATCH_ANSWERS.all_right}”`, actions: [] }]);

    w.clock = CLOSES;
    expect(await watchCardOf(w)).toEqual([]);
  });

  it('does not show her answer on the home screen before the member has given theirs: the question is still open', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    await hers(w.table).answers('not_for_me', OPENS + 21 * MIN);
    w.clock = OPENS + 22 * MIN;

    const cards = await watchCardOf(w);

    expect(cards).toEqual([{ id: CARD, kind: 'watch', headline: 'Sintel has ended. There is one question for you.', actions: [SEAT, LATER] }]);
    expect(JSON.stringify(cards)).not.toContain(WATCH_ANSWERS.not_for_me);
  });

  it('ranks what was said about the film with the other settled notes: below what waits, above her week, and never in what waits', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    await press(w, 'loved_it');
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'NARR#2026-W42' }, data: { S: JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W42', text: 'A quiet week.', deltas: [], timeline: [], generatedAt: OPENS, residentSeenAt: OPENS }) } });
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'CARD#door-abc' }, data: { S: JSON.stringify({ id: 'door-abc', urgency: 'DOOR', queuedAt: w.clock - MIN, expiresAt: w.clock + 4 * MIN, shownCount: 0, card: { type: 'DOOR', id: 'door-abc', householdId: 'hh-1', line: "Someone's at the front door.", actions: [] } }) } });
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'LOOK#door-abc' }, cardId: { S: 'door-abc' }, askedAt: { N: String(w.clock - 30_000) } });

    expect((await homeOf(w)).cards.map((card) => [card.kind, card.actions.length])).toEqual([['door_look', 3], ['watch', 0], ['week', 2]]);
    // Asked by another of her televisions, whose app is off the screen: this one has just shown its home.
    putFamilyTv(w.table, { deviceId: 'tv-kitchen' });
    const told = await w.tv.waiting(bearer(token({ deviceId: 'tv-kitchen', householdId: 'hh-1', kind: 'family', userId: 'u_sarah' })));
    expect(told.body).toEqual({ waiting: [{ id: 'ftv-door_look-door-abc', line: 'Margaret has asked you to look at the door.' }] });
  });

  it('is told to the member who watched with her, and to nobody else in the circle', async () => {
    const w = await seated();
    const davids = await withDavid(w);
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    await press(w, 'loved_it');
    await hers(w.table).answers('all_right', OPENS + 22 * MIN);

    expect(await watchCardOf(w, davids)).toEqual([]);
    expect(JSON.stringify(await homeOf(w, davids))).not.toMatch(/Sintel|loved|all right/i);
    expect(await seatOf(w, davids)).toEqual({});
  });

  it('has nothing more to say once she chose not to, she left, or the time has passed', async () => {
    const passed = await seated();
    await hers(passed.table).saysNotNow(OPENS + MIN);

    const left = await seated();
    await hers(left.table).starts(OPENS + MIN);
    await hers(left.table).plays('PLAYING', 1_000, OPENS + 2 * MIN);
    await hers(left.table).plays('STOPPED', 60_000, OPENS + 3 * MIN);
    left.clock = OPENS + 4 * MIN;

    const late = await accepted(CLOSES);

    for (const w of [passed, left, late]) expect(await watchCardOf(w)).toEqual([]);
  });

  it('shows the one that wants something when there are two: the question of the last film before a later one still ahead', async () => {
    const w = await world();
    // An hour ago: she said yes, Sarah sat down, she started it, and it has reached its credits.
    invite(w.table, { sessionId: 'ws-old', startsAt: NOW - 60 * MIN, createdAt: NOW - 24 * 60 * MIN });
    const earlier = hers(w.table, 'ws-old');
    await earlier.accepts(NOW - 23 * 60 * MIN);
    w.clock = NOW - 70 * MIN;
    await press(w, FAMILY_TV_PRESSES.sit, familyTvCardId('watch', 'ws-old'));
    await earlier.starts(NOW - 60 * MIN);
    await earlier.isAsked(NOW - 40 * MIN);
    w.clock = NOW;
    // And another, for Sunday, which she has also said yes to.
    invite(w.table);
    await hers(w.table).accepts(NOW);

    const cards = await watchCardOf(w);

    expect(cards).toMatchObject([{ id: familyTvCardId('watch', 'ws-old'), headline: 'Sintel has ended. There is one question for you.' }]);
  });

  it('is put above her week and below what waits for an answer when it only says when', async () => {
    const w = await accepted(NOW);
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'NARR#2026-W41' }, data: { S: JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W41', text: 'A quiet week.', deltas: [], timeline: [], generatedAt: NOW, residentSeenAt: NOW }) } });

    expect((await homeOf(w)).cards.map((card) => card.kind)).toEqual(['watch', 'week']);
  });

  it('is shown to the member who asked her, and to nobody else in the circle', async () => {
    const w = await seated();
    const davids = await withDavid(w);
    await hers(w.table).starts(OPENS + MIN);
    w.clock = OPENS + 2 * MIN;
    const noFilm = await world();
    const davidsAlone = await withDavid(noFilm);
    noFilm.clock = w.clock;

    expect(await watchCardOf(w, davids)).toEqual([]);
    expect(JSON.stringify(await homeOf(w, davids))).toBe(JSON.stringify(await homeOf(noFilm, davidsAlone)));
    expect(JSON.stringify(await homeOf(w, davids))).not.toMatch(/Sintel|film|watch/i);
  });
});

describe('POST /tv/press — sitting down', () => {
  it('does what join_watch_together does: the seat is taken, and her television says who is ready', async () => {
    const w = await accepted();

    const reply = await press(w, FAMILY_TV_PRESSES.sit);

    expect(reply).toEqual({ status: 200, body: { done: true, say: 'You have sat down. Margaret’s television says you are ready.' } });
    expect(session(w.table)).toMatchObject({ status: 'accepted', joinedAt: OPENS });
    expect(w.cards).toHaveLength(1);
    expect(w.cards[0]).toMatchObject({
      id: watchCardId('ready', 'ws-1'),
      urgency: 'DEFERRED',
      card: { type: 'WATCH', householdId: 'hh-1', headline: 'Sarah is ready to watch Sintel with you.', programmeId: 'sintel', followedUntil: CLOSES },
    });
  });

  it('tells her television once: sitting down again sends nothing more', async () => {
    const w = await seated();

    const again = await press(w, FAMILY_TV_PRESSES.sit);

    expect(again).toEqual({ status: 200, body: { done: true, say: 'You have already sat down.' } });
    expect(w.cards).toHaveLength(1);
  });

  it.each([
    ['before it is time', async () => accepted(OPENS - 1), 'It is not time yet. Sintel with Margaret is on Sunday 18 October at 3 pm; you can sit down from half an hour before.'],
    ['before she has answered', async () => { const w = await world(); invite(w.table); w.clock = OPENS; return w; }, "Margaret hasn't answered the invitation yet. It is on the television."],
    ['after she said no', async () => { const w = await world(); invite(w.table); await hers(w.table).declines(NOW); w.clock = OPENS; return w; }, 'Margaret said not this time.'],
    ['when the time has passed', async () => accepted(CLOSES), 'The time for Sintel has passed. You can ask again for another day.'],
    ['when there is no such film', async () => world(), "You haven't asked Margaret to watch anything."],
  ])('refuses in the tool’s own sentence %s', async (_name, home, sentence) => {
    const w = await home();

    expect(await press(w, FAMILY_TV_PRESSES.sit)).toEqual({ status: 200, body: { done: false, say: sentence } });
    expect(w.cards).toEqual([]);
    expect(session(w.table)?.joinedAt).toBeUndefined();
  });

  it('is not open to anybody but the member who asked her: they are told what they would be with no film at all', async () => {
    const w = await accepted();
    const davids = await withDavid(w);
    const none = await world();
    const davidsAlone = await withDavid(none);

    const reply = await press(w, FAMILY_TV_PRESSES.sit, CARD, davids);

    expect(reply).toEqual({ status: 200, body: { done: false, say: "You haven't asked Margaret to watch anything." } });
    expect(reply).toEqual(await press(none, FAMILY_TV_PRESSES.sit, CARD, davidsAlone));
    expect(w.cards).toEqual([]);
    expect(session(w.table)?.joinedAt).toBeUndefined();
  });

  it.each([
    ['her “Start the film”', 'start'],
    ['her yes', 'accept'],
    ['her no', 'decline'],
    ['the television’s own “Take your seat”, which sends nothing', FAMILY_TV_OWN_ACTIONS.seat],
    ['words of the caller’s own', 'Start it for her'],
  ])('answers 400 bad_action to %s: no press here is ever hers', async (_name, action) => {
    const w = await seated();
    const before = JSON.stringify(session(w.table));

    expect(await press(w, action)).toEqual({ status: 400, body: { error: 'bad_action' } });
    expect(JSON.stringify(session(w.table))).toBe(before);
    expect(w.cards).toHaveLength(1);
  });

  it('answers 400 bad_card to a film whose id is not one', async () => {
    const w = await accepted();

    expect(await press(w, FAMILY_TV_PRESSES.sit, `ftv-watch-${'a'.repeat(65)}`)).toEqual({ status: 400, body: { error: 'bad_card' } });
  });
});

describe('POST /tv/press — the one question at the end', () => {
  async function atTheCredits(): Promise<World> {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    return w;
  }

  it('does what answer_watch_together does: the chosen sentence goes on her television under the member’s name', async () => {
    const w = await atTheCredits();

    const reply = await press(w, 'loved_it');

    expect(reply).toEqual({ status: 200, body: { done: true, say: `It is on the television now: “Sarah says: ${WATCH_ANSWERS.loved_it}”` } });
    expect(session(w.table)).toMatchObject({ familyAnswer: 'loved_it' });
    expect(w.cards.at(-1)).toMatchObject({ id: watchCardId('answer', 'ws-1'), card: { type: 'WATCH', headline: `Sarah says: “${WATCH_ANSWERS.loved_it}”` } });
  });

  it('is given once', async () => {
    const w = await atTheCredits();
    await press(w, 'loved_it');

    expect(await press(w, 'not_for_me')).toEqual({ status: 200, body: { done: false, say: `You have already answered: “${WATCH_ANSWERS.loved_it}”` } });
    expect(session(w.table)).toMatchObject({ familyAnswer: 'loved_it' });
    expect(w.cards).toHaveLength(2);
  });

  it('cannot be given before the film has reached its end', async () => {
    const w = await seated();

    expect(await press(w, 'loved_it')).toEqual({ status: 200, body: { done: false, say: 'The film has not reached its end yet.' } });
    expect(session(w.table)?.familyAnswer).toBeUndefined();
  });

  it('is not anybody else’s to give', async () => {
    const w = await atTheCredits();
    const davids = await withDavid(w);

    expect(await press(w, 'loved_it', CARD, davids)).toEqual({ status: 200, body: { done: false, say: "You haven't asked Margaret to watch anything." } });
    expect(session(w.table)?.familyAnswer).toBeUndefined();
  });
});

describe('GET /tv/seat', () => {
  const stream = { url: expect.stringMatching(/\/sintel\/index\.m3u8$/) as unknown, durationMs: SINTEL.durationMs, attribution: SINTEL.attribution };

  it('is empty when there is no film, before she has answered, and before the member has sat down', async () => {
    const none = await world();
    const invited = await world();
    invite(invited.table);
    const notSat = await accepted();

    for (const w of [none, invited, notSat]) expect(await seatOf(w)).toEqual({});
  });

  it('waits for her to start the film once the member has sat down', async () => {
    const w = await seated();

    expect(await seatOf(w)).toEqual({ seat: { cardId: CARD, film: 'Sintel', state: 'waiting', line: 'Waiting for Margaret to start the film.', stream } });
  });

  it('follows her film from her press on “Start the film”: where it is, and how long ago her television said so', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).plays('PLAYING', 42_000, OPENS + 2 * MIN);
    w.clock = OPENS + 2 * MIN + 3_000;

    expect(await seatOf(w)).toEqual({
      seat: {
        cardId: CARD,
        film: 'Sintel',
        state: 'watching',
        line: 'You are watching Sintel with Margaret.',
        stream,
        playback: { state: 'PLAYING', positionMs: 42_000, ageMs: 3_000 },
      },
    });
  });

  it('asks the one question at the credits, with the answers as buttons', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;

    expect((await seatOf(w)).seat).toMatchObject({
      cardId: CARD,
      state: 'asked',
      line: WATCH_QUESTION,
      question: WATCH_QUESTION,
      answers: [
        { id: 'loved_it', label: WATCH_ANSWERS.loved_it, kind: 'primary' },
        { id: 'all_right', label: WATCH_ANSWERS.all_right, kind: 'secondary' },
        { id: 'not_for_me', label: WATCH_ANSWERS.not_for_me, kind: 'secondary' },
      ],
    });
  });

  it('says what the member said once they have answered, and that she has not yet — then what she said, when she has', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    await press(w, 'loved_it');

    const waitingForHers = (await seatOf(w)).seat;
    expect(waitingForHers).toMatchObject({ state: 'over', line: `You said: “${WATCH_ANSWERS.loved_it}” Margaret has not answered yet.`, question: WATCH_QUESTION, yourAnswer: WATCH_ANSWERS.loved_it });
    expect(waitingForHers).not.toHaveProperty('theirAnswer');
    expect(waitingForHers).not.toHaveProperty('answers');

    // The seat goes on being asked while it is over, so this arrives by itself.
    await hers(w.table).answers('loved_it', OPENS + 22 * MIN);

    expect((await seatOf(w)).seat).toMatchObject({
      state: 'over',
      line: `You said: “${WATCH_ANSWERS.loved_it}” Margaret said: “${WATCH_ANSWERS.loved_it}”`,
      yourAnswer: WATCH_ANSWERS.loved_it,
      theirAnswer: WATCH_ANSWERS.loved_it,
    });
  });

  it('keeps the question open, in the question’s own words, when only she has answered: no more than the tool gives', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    await hers(w.table).answers('not_for_me', OPENS + 21 * MIN);
    w.clock = OPENS + 22 * MIN;

    const { seat } = await seatOf(w);

    expect(seat).toMatchObject({ state: 'asked', line: WATCH_QUESTION, question: WATCH_QUESTION });
    expect(seat!.answers).toHaveLength(3);
    expect(seat!.line).not.toContain(WATCH_ANSWERS.not_for_me);
    // The one place her answer is: the field get_watch_together itself carries at this moment.
    expect(describeWatch(session(w.table)!, w.clock).theirAnswer).toBe(WATCH_ANSWERS.not_for_me);
    expect(seat!.theirAnswer).toBe(WATCH_ANSWERS.not_for_me);
  });

  it('says so when she leaves the film, and follows nothing after', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).plays('PLAYING', 1_000, OPENS + 2 * MIN);
    await hers(w.table).plays('STOPPED', 60_000, OPENS + 3 * MIN);
    w.clock = OPENS + 4 * MIN;

    expect(await seatOf(w)).toEqual({ seat: { cardId: CARD, film: 'Sintel', state: 'over', line: 'Margaret has left the film.' } });
  });

  it('says so when she chose not to watch after all', async () => {
    const w = await seated();
    await hers(w.table).saysNotNow(OPENS + MIN);

    expect(await seatOf(w)).toEqual({ seat: { cardId: CARD, film: 'Sintel', state: 'over', line: 'Margaret chose not to watch just now.' } });
  });

  it('is empty again once the time for the film has passed — whatever was being followed', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).plays('PLAYING', 42_000, OPENS + 2 * MIN);

    w.clock = CLOSES - 1;
    expect((await seatOf(w)).seat).toMatchObject({ state: 'watching' });
    w.clock = CLOSES;
    expect(await seatOf(w)).toEqual({});
  });

  it('is empty after the window even for a film that reached its end and was answered', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).isAsked(OPENS + 20 * MIN);
    w.clock = OPENS + 21 * MIN;
    await press(w, 'loved_it');

    w.clock = CLOSES - 1;
    expect((await seatOf(w)).seat).toMatchObject({ state: 'over' });
    w.clock = CLOSES;
    expect(await seatOf(w)).toEqual({});
  });

  it('is for somebody who sat down: a row that says she passed, with nobody seated, is no seat', async () => {
    const w = await accepted();
    const row = w.table.rows('HH#hh-1').find((item) => item.sk?.S === 'WATCH#ws-1')!;
    w.table.put({ ...row, passedAt: { N: String(OPENS) } });

    expect(await seatOf(w)).toEqual({});
  });

  it('is nobody else’s: another member is answered exactly as when there is no film at all', async () => {
    const w = await seated();
    const davids = await withDavid(w);
    await hers(w.table).starts(OPENS + MIN);
    await hers(w.table).plays('PLAYING', 42_000, OPENS + 2 * MIN);
    w.clock = OPENS + 3 * MIN;
    const none = await world();
    const davidsAlone = await withDavid(none);

    const reply = await w.tv.seat(davids);

    expect(reply).toEqual({ status: 200, body: {} });
    expect(JSON.stringify(reply)).toBe(JSON.stringify(await none.tv.seat(davidsAlone)));
  });

  it('is not a look, writes nothing, and costs the television’s own row and one read of the films', async () => {
    const w = await seated();
    await hers(w.table).starts(OPENS + MIN);
    const from = householdRequests(w).length;
    const calls = w.storeCalls.length;

    for (let i = 0; i < 5; i += 1) await seatOf(w);

    const made = householdRequests(w).slice(from);
    expect(made).toHaveLength(10);
    expect(made.slice(0, 2)).toEqual([
      { command: 'GetItemCommand', pk: 'HH#hh-1', sk: 'FTV#tv-sarah', consistent: true },
      { command: 'QueryCommand', pk: 'HH#hh-1', sk: 'WATCH#', consistent: false },
    ]);
    expect(made.every((r) => r.command === 'GetItemCommand' || r.command === 'QueryCommand')).toBe(true);
    expect(w.storeCalls.slice(calls)).toEqual(Array.from({ length: 5 }, () => ['getMembership', 'getHousehold']).flat());
    expect(lookInRow(w.table)).toBeUndefined();
    expect(w.homes).toEqual([]);
  });
});
