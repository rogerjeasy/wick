/**
 * Sarah's television, a wave: one button, one card on her television in
 * Wick's own words, and — if she waves back — one card here. Her press is
 * carried out by the edge's own code, as it is deployed
 * (edge-device note-reply.mjs, card-acted.mjs).
 */
import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { FAMILY_TV_PRESSES, FAMILY_TV_WAVE_CARD, familyTvCardId, type FamilyTvWaiting, type QueuedCard } from '@wick/contracts';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { markNoteReplied, replyIndex, replyText } from '../../../../edge-device/lambda/note-reply.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { markCardActed, retiresCard } from '../../../../edge-device/lambda/card-acted.mjs';
import type { MemoryTable } from '../../__tests__/memoryTable.js';
import { loadNoteReplies } from '../../tools/get_replies.js';
import { WAVE_AGAIN_AFTER_MS, WAVE_BACK_SHOWN_MS, WAVE_KEPT_MS } from '../familyTvWave.js';
import { HOUR, MIN, NOW, PICTURE, SARAHS_TV, bearer, homeOf, householdRequests, member, putDoorCard, putFamilyTv, putLook, token, world, type World } from './familyTvWorld.js';

const WAVE = { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.wave };
const CAN_WAVE = { label: 'Wave to Margaret', cardId: FAMILY_TV_WAVE_CARD };
const ON_ITS_WAY = { label: 'Wave to Margaret', line: 'Your wave is on its way to Margaret’s television.' };
const SENT = { done: true, say: 'Your wave is on its way to Margaret’s television. It will wait for a quiet moment.' };

const waveRow = (table: MemoryTable, userId = 'u_sarah') => table.rows('HH#hh-1').find((row) => row.sk?.S === `WAVE#${userId}`);
const cardRow = (table: MemoryTable, cardId: string) => table.rows('HH#hh-1').find((row) => row.sk?.S === `CARD#${cardId}`);

/** What egress.ts does with a card it is given: keeps it as the queue's source of truth. */
function deliver(w: World, card: QueuedCard = w.cards.at(-1)!): QueuedCard {
  w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: `CARD#${card.id}` }, data: { S: JSON.stringify(card) } });
  return card;
}

/** Sarah presses the wave button, and the card reaches Margaret's television. */
async function wave(w: World, authorization: string = bearer()): Promise<QueuedCard> {
  const before = w.cards.length;
  const reply = await w.tv.press(authorization, WAVE);
  expect(reply).toEqual({ status: 200, body: SENT });
  expect(w.cards).toHaveLength(before + 1);
  return deliver(w);
}

/**
 * Margaret presses one of the card's buttons. This is device-event.mjs's own
 * sequence for a card_action, with the edge's own updates: the card is
 * finished, and a reply to a note is kept in the words Wick offered.
 */
async function herPress(w: World, card: QueuedCard, button: 0 | 1, at: number = w.clock): Promise<void> {
  const action = `reply_${button}`;
  const send = (input: object): Promise<unknown> => w.table.ddb.send(new UpdateItemCommand(input as never));
  if ((retiresCard as (a: string) => boolean)(action)) await send((markCardActed as (i: object) => object)({ table: 'wick', householdId: 'hh-1', cardId: card.id, at }));
  const index = (replyIndex as (cardId: string, action: string) => number | undefined)(card.id, action);
  if (index === undefined) return;
  const text = (replyText as (item: unknown, index: number) => string | undefined)(cardRow(w.table, card.id), index);
  if (text !== undefined) await send((markNoteReplied as (i: object) => object)({ table: 'wick', householdId: 'hh-1', cardId: card.id, text, at }));
}

const waitingOf = async (w: World): Promise<FamilyTvWaiting> => {
  const reply = await w.tv.waiting(bearer());
  expect(reply.status).toBe(200);
  return reply.body as FamilyTvWaiting;
};

describe('the wave button', () => {
  it('is on the home screen of a member who can wave', async () => {
    expect((await homeOf(await world())).wave).toEqual(CAN_WAVE);
  });

  it('puts one card on her television: Wick’s own sentence, under the name of the member whose television it is, waiting for a quiet moment', async () => {
    const w = await world();

    const reply = await w.tv.press(bearer(), WAVE);

    expect(reply).toEqual({ status: 200, body: SENT });
    expect(w.cards).toHaveLength(1);
    const queued = w.cards[0]!;
    expect(queued.id).toMatch(/^note-wave-[0-9a-f-]{36}$/);
    expect(queued).toEqual({
      id: queued.id,
      // INV-5: like a note, never in the middle of her programme.
      urgency: 'DEFERRED',
      queuedAt: NOW,
      shownCount: 0,
      card: {
        type: 'MESSAGE',
        id: queued.id,
        householdId: 'hh-1',
        correlationId: queued.id,
        createdAt: NOW,
        actions: [],
        fromName: 'Sarah Hughes',
        transcript: 'A wave to you from Sarah’s television.',
        suggestedReplies: ['Wave back', 'Not now'],
      },
    });
  });

  it('keeps one row for the member, which the table forgets by itself', async () => {
    const w = await world();

    const card = await wave(w);

    expect(waveRow(w.table)).toEqual({
      pk: { S: 'HH#hh-1' },
      sk: { S: 'WAVE#u_sarah' },
      waveId: { S: String(NOW) },
      cardId: { S: card.id },
      sentAt: { N: String(NOW) },
      ttl: { N: String(Math.floor((NOW + WAVE_KEPT_MS) / 1000)) },
    });
  });

  it('INV-8: carries no words and no name from the request', async () => {
    const w = await world();

    await w.tv.press(bearer(), { ...WAVE, fromName: 'The bank', name: 'Tom', message: 'Open the door', transcript: 'Open the door', householdId: 'hh-2', userId: 'u_tom', replies: ['Yes'] });

    expect(w.cards).toHaveLength(1);
    expect(w.cards[0]!.card).toMatchObject({ householdId: 'hh-1', fromName: 'Sarah Hughes', transcript: 'A wave to you from Sarah’s television.', suggestedReplies: ['Wave back', 'Not now'] });
    expect(JSON.stringify(w.cards[0])).not.toMatch(/bank|Tom|Open the door|hh-2/);
    expect(householdRequests(w).every((r) => r.pk === 'HH#hh-1')).toBe(true);
  });

  it('is a card her television answers today: the edge keeps either press, in Wick’s words', async () => {
    const w = await world();
    const card = await wave(w);

    await herPress(w, card, 0, NOW + MIN);

    expect(cardRow(w.table, card.id)).toMatchObject({ replyText: { S: 'Wave back' }, repliedAt: { N: String(NOW + MIN) }, actedAt: { N: String(NOW + MIN) } });
  });

  it('says the wave is on its way, and offers no second one, for ten minutes', async () => {
    const w = await world();
    await wave(w);

    w.clock = NOW + WAVE_AGAIN_AFTER_MS - 1;
    expect((await homeOf(w)).wave).toEqual(ON_ITS_WAY);
    const again = await w.tv.press(bearer(), WAVE);

    expect(again).toEqual({ status: 200, body: { done: false, say: 'Your wave is still on its way to Margaret’s television. You can wave again in a few minutes.' } });
    expect(w.cards).toHaveLength(1);
    expect(w.withdrawn).toEqual([]);
    expect(waveRow(w.table)).toMatchObject({ waveId: { S: String(NOW) } });
  });

  it('offers the button again after ten minutes, and a new wave takes the old card back before it sends another', async () => {
    const w = await world();
    const first = await wave(w);
    w.clock = NOW + WAVE_AGAIN_AFTER_MS;
    expect((await homeOf(w)).wave).toEqual(CAN_WAVE);
    const order: string[] = [];
    w.before((request) => {
      if (request.command === 'PutItemCommand' && request.sk === 'WAVE#u_sarah') order.push(`claimed with ${w.withdrawn.length} taken back and ${w.cards.length} sent`);
    });

    const second = await wave(w);

    // The claim, then the old card off her television, then the new one: never two of a member's waves on it at once.
    expect(order).toEqual(['claimed with 0 taken back and 1 sent']);
    expect(w.withdrawn).toEqual([{ householdId: 'hh-1', cardId: first.id }]);
    expect(w.cards).toHaveLength(2);
    expect(second.id).not.toBe(first.id);
    expect(waveRow(w.table)).toMatchObject({ waveId: { S: String(w.clock) }, cardId: { S: second.id }, sentAt: { N: String(w.clock) } });
    expect((await homeOf(w)).wave).toEqual(ON_ITS_WAY);
  });

  it('sends one wave when two of the member’s televisions press in the same moment', async () => {
    const w = await world();
    let raced = false;
    w.before((request) => {
      if (request.command !== 'PutItemCommand' || request.sk !== 'WAVE#u_sarah' || raced) return;
      raced = true;
      w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'WAVE#u_sarah' }, waveId: { S: String(NOW - 1) }, cardId: { S: 'note-wave-other' }, sentAt: { N: String(NOW - 1) } });
    });

    const reply = await w.tv.press(bearer(), WAVE);

    expect(raced).toBe(true);
    expect(reply).toEqual({ status: 200, body: { done: false, say: 'Your wave is still on its way to Margaret’s television. You can wave again in a few minutes.' } });
    expect(w.cards).toEqual([]);
    expect(waveRow(w.table)).toMatchObject({ cardId: { S: 'note-wave-other' } });
  });

  it('does not say a wave is on its way when it could not be sent', async () => {
    const w = await world();
    w.sendFails = true;

    await expect(w.tv.press(bearer(), WAVE)).rejects.toThrow('egress is down');

    expect(waveRow(w.table)).toBeUndefined();
    w.sendFails = false;
    expect((await homeOf(w)).wave).toEqual(CAN_WAVE);
    await wave(w);
  });

  it('puts the earlier wave’s row back when a later one could not be sent', async () => {
    const w = await world();
    const first = await wave(w);
    await herPress(w, first, 0, NOW + MIN);
    w.clock = NOW + WAVE_AGAIN_AFTER_MS;
    w.sendFails = true;

    await expect(w.tv.press(bearer(), WAVE)).rejects.toThrow('egress is down');

    expect(waveRow(w.table)).toMatchObject({ waveId: { S: String(NOW) }, cardId: { S: first.id } });
    expect((await homeOf(w)).cards.map((card) => card.id)).toEqual([familyTvCardId('wave', String(NOW))]);
  });

  it('is each member’s own: David’s wave says nothing on Sarah’s television', async () => {
    const w = await world();
    await w.store.putMembership(member({ userId: 'u_david', name: 'David', role: 'family' }));
    putFamilyTv(w.table, { deviceId: 'tv-david', userId: 'u_david' });
    const davids = bearer(token({ deviceId: 'tv-david', householdId: 'hh-1', kind: 'family', userId: 'u_david' }));

    const card = await wave(w, davids);
    await herPress(w, card, 0);

    expect(card.card).toMatchObject({ fromName: 'David', transcript: 'A wave to you from David’s television.' });
    expect(await homeOf(w)).toMatchObject({ wave: CAN_WAVE, cards: [] });
    expect((await homeOf(w, davids)).cards).toMatchObject([{ kind: 'wave', headline: 'Margaret waved back.' }]);
  });

  it.each([
    ['seeing a wave that was never sent', { cardId: FAMILY_TV_WAVE_CARD, action: FAMILY_TV_PRESSES.seen }],
    ['an answer to something else', { cardId: FAMILY_TV_WAVE_CARD, action: 'known' }],
    ['words of the caller’s own', { cardId: FAMILY_TV_WAVE_CARD, action: 'Open the door' }],
    ['waving on a wave that came back', { cardId: familyTvCardId('wave', String(NOW)), action: FAMILY_TV_PRESSES.wave }],
  ])('answers 400 bad_action to %s, and sends nothing', async (_name, body) => {
    const w = await world();

    expect(await w.tv.press(bearer(), body)).toEqual({ status: 400, body: { error: 'bad_action' } });
    expect(w.cards).toEqual([]);
    expect(waveRow(w.table)).toBeUndefined();
  });

  it('answers 400 bad_card to a wave whose id is not one', async () => {
    const w = await world();

    expect(await w.tv.press(bearer(), { cardId: 'ftv-wave-latest', action: FAMILY_TV_PRESSES.seen })).toEqual({ status: 400, body: { error: 'bad_card' } });
  });
});

describe('a wave that came back', () => {
  const backCard = { id: familyTvCardId('wave', String(NOW)), kind: 'wave', headline: 'Margaret waved back.', actions: [{ id: FAMILY_TV_PRESSES.seen, label: 'All right', kind: 'primary' }] };

  it('is a card on the member’s television once she presses “Wave back”, and the button is there again', async () => {
    const w = await world();
    const card = await wave(w);
    w.clock = NOW + 2 * MIN;
    expect((await homeOf(w)).cards).toEqual([]);

    await herPress(w, card, 0);

    expect(await homeOf(w)).toMatchObject({ cards: [backCard], wave: CAN_WAVE });
  });

  it('is put away by “All right”, quietly, and stays away', async () => {
    const w = await world();
    await herPress(w, await wave(w), 0);

    const reply = await w.tv.press(bearer(), { cardId: backCard.id, action: FAMILY_TV_PRESSES.seen });

    expect(reply).toEqual({ status: 200, body: { done: true, say: 'Margaret waved back.' } });
    expect(waveRow(w.table)).toMatchObject({ seenAt: { N: String(NOW) } });
    expect((await homeOf(w)).cards).toEqual([]);
    expect((await w.tv.press(bearer(), { cardId: backCard.id, action: FAMILY_TV_PRESSES.seen })).status).toBe(200);
    expect(w.cards).toHaveLength(1);
  });

  it('goes by itself twelve hours after she waved back', async () => {
    const w = await world();
    const card = await wave(w);
    await herPress(w, card, 0, NOW + HOUR);

    w.clock = NOW + HOUR + WAVE_BACK_SHOWN_MS - 1;
    expect((await homeOf(w)).cards).toEqual([backCard]);
    w.clock = NOW + HOUR + WAVE_BACK_SHOWN_MS;
    expect((await homeOf(w)).cards).toEqual([]);
  });

  it('changes nothing when what is “seen” is not the wave that came back', async () => {
    const w = await world();
    await herPress(w, await wave(w), 0);

    const other = await w.tv.press(bearer(), { cardId: familyTvCardId('wave', String(NOW - 5 * MIN)), action: FAMILY_TV_PRESSES.seen });
    const none = await (await world()).tv.press(bearer(), { cardId: backCard.id, action: FAMILY_TV_PRESSES.seen });

    expect(other).toEqual({ status: 200, body: { done: false, say: 'That wave is not here any more.' } });
    expect(none).toEqual(other);
    expect(waveRow(w.table)?.seenAt).toBeUndefined();
    expect((await homeOf(w)).cards).toEqual([backCard]);
  });

  it('cannot be “seen” before it has come back: saying so is not a way to wave again sooner', async () => {
    const w = await world();
    await wave(w);

    const seen = await w.tv.press(bearer(), { cardId: backCard.id, action: FAMILY_TV_PRESSES.seen });
    const again = await w.tv.press(bearer(), WAVE);

    expect(seen).toEqual({ status: 200, body: { done: false, say: 'That wave is not here any more.' } });
    expect(waveRow(w.table)?.seenAt).toBeUndefined();
    expect(again.body).toMatchObject({ done: false });
    expect(w.cards).toHaveLength(1);
  });

  it('counts only for the wave now on her television: a press on one taken back says nothing', async () => {
    const w = await world();
    const first = await wave(w);
    w.clock = NOW + WAVE_AGAIN_AFTER_MS;
    await wave(w);

    await herPress(w, first, 0);

    expect((await homeOf(w)).cards).toEqual([]);
  });

  it('sits below what waits for an answer and above the rest', async () => {
    const w = await world();
    await herPress(w, await wave(w), 0);
    putDoorCard(w.table, 'door-abc', { imageRef: PICTURE });
    putLook(w.table, 'door-abc', NOW - 30_000);
    w.table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'NARR#2026-W41' }, data: { S: JSON.stringify({ householdId: 'hh-1', isoWeek: '2026-W41', text: 'A quiet week.', deltas: [], timeline: [], generatedAt: NOW - HOUR, residentSeenAt: NOW - HOUR }) } });

    expect((await homeOf(w)).cards.map((card) => card.kind)).toEqual(['door_look', 'wave', 'week']);
  });
});

describe('a wave she put away', () => {
  /** Two homes, alike but for what she pressed: “Not now” in one, nothing at all in the other. */
  async function pair(): Promise<{ putAway: World; unseen: World }> {
    const putAway = await world();
    const unseen = await world();
    await herPress(putAway, await wave(putAway), 1, NOW + MIN);
    await wave(unseen);
    return { putAway, unseen };
  }

  it('is kept by the edge, and read by nothing the family has', async () => {
    const { putAway } = await pair();

    expect(cardRow(putAway.table, putAway.cards[0]!.id)).toMatchObject({ replyText: { S: 'Not now' } });
    expect(await loadNoteReplies(putAway.table.ddb, 'hh-1', 'u_sarah', NOW + HOUR)).toEqual([]);
  });

  it.each([
    ['five minutes on', 5 * MIN],
    ['at ten minutes', WAVE_AGAIN_AFTER_MS],
    ['an hour on', HOUR],
    ['a day on', 24 * HOUR],
    ['when the table has forgotten the wave', WAVE_KEPT_MS + HOUR],
  ])('looks to the family exactly like a wave not yet seen, %s', async (_name, later) => {
    const { putAway, unseen } = await pair();
    putAway.clock = unseen.clock = NOW + later;

    // What is waiting first: a television that has just shown its home is told nothing is.
    expect(JSON.stringify(await waitingOf(putAway))).toBe(JSON.stringify(await waitingOf(unseen)));
    expect(await waitingOf(putAway)).toEqual({ waiting: [] });
    expect(JSON.stringify(await homeOf(putAway))).toBe(JSON.stringify(await homeOf(unseen)));
    expect((await homeOf(putAway)).cards).toEqual([]);
  });

  it('refuses a second wave in the same words, and takes the next one at the same ten minutes, either way', async () => {
    const { putAway, unseen } = await pair();

    putAway.clock = unseen.clock = NOW + WAVE_AGAIN_AFTER_MS - 1;
    const early = await putAway.tv.press(bearer(), WAVE);
    expect(early.body).toMatchObject({ done: false });
    expect(early).toEqual(await unseen.tv.press(bearer(), WAVE));

    putAway.clock = unseen.clock = NOW + WAVE_AGAIN_AFTER_MS;
    expect(await putAway.tv.press(bearer(), WAVE)).toEqual(await unseen.tv.press(bearer(), WAVE));
    expect(putAway.cards).toHaveLength(2);
    expect(unseen.cards).toHaveLength(2);
    // The same is done about the old card in both: nothing in what the server does tells them apart.
    expect(putAway.withdrawn).toHaveLength(1);
    expect(unseen.withdrawn).toHaveLength(1);
  });
});

describe('a wave is not a note', () => {
  it('never appears in get_replies — sent, waved back to, or put away — beside the notes that do', async () => {
    const w = await world();
    w.table.put({
      pk: { S: 'HH#hh-1' },
      sk: { S: 'CARD#note-1' },
      sentBy: { S: 'u_sarah' },
      data: { S: JSON.stringify({ id: 'note-1', queuedAt: NOW - HOUR, card: { type: 'MESSAGE', fromName: 'Sarah Hughes', transcript: 'Lunch on Sunday?', suggestedReplies: ['Yes, please do.', 'Another day would be better.', 'Not right now.'] } }) },
    });

    const sent = await wave(w);
    const unanswered = await loadNoteReplies(w.table.ddb, 'hh-1', 'u_sarah', NOW + MIN);
    await herPress(w, sent, 0, NOW + MIN);
    const answered = await loadNoteReplies(w.table.ddb, 'hh-1', 'u_sarah', NOW + 2 * MIN);

    const onlyTheNote = [{ from: 'Sarah Hughes', message: 'Lunch on Sunday?', sentAt: NOW - HOUR, reply: null }];
    expect(unanswered).toEqual(onlyTheNote);
    expect(answered).toEqual(onlyTheNote);
  });
});

describe('what a wave costs to look at', () => {
  const waveReads = (w: World, from: number) => householdRequests(w).slice(from).filter((r) => r.sk.startsWith('WAVE#') || r.sk.startsWith('CARD#note-wave-')).map((r) => `${r.command} ${r.sk.replace(/note-wave-.*/, 'note-wave')}`);

  it('is one read when no wave is out, and one more while one is', async () => {
    const w = await world();

    let from = householdRequests(w).length;
    await homeOf(w);
    expect(waveReads(w, from)).toEqual(['GetItemCommand WAVE#u_sarah']);

    await wave(w);
    from = householdRequests(w).length;
    await homeOf(w);
    expect(waveReads(w, from)).toEqual(['GetItemCommand WAVE#u_sarah', 'GetItemCommand CARD#note-wave']);
  });

  it('is one read again once the wave that came back has been seen, or the wave is two days old', async () => {
    const seen = await world();
    await herPress(seen, await wave(seen), 0);
    await seen.tv.press(bearer(), { cardId: familyTvCardId('wave', String(NOW)), action: FAMILY_TV_PRESSES.seen });
    const old = await world();
    await wave(old);
    old.clock = NOW + WAVE_KEPT_MS;

    for (const w of [seen, old]) {
      const from = householdRequests(w).length;
      await homeOf(w);
      expect(waveReads(w, from)).toEqual(['GetItemCommand WAVE#u_sarah']);
    }
  });

  it('is asked of the home in the token and no other', async () => {
    const w = await world();
    await wave(w);
    await homeOf(w);

    expect(householdRequests(w).every((r) => r.pk === 'HH#hh-1')).toBe(true);
    expect(SARAHS_TV.householdId).toBe('hh-1');
  });
});
