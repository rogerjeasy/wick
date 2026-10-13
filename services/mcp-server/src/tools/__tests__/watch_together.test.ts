import { describe, expect, it } from 'vitest';
import { UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  MAX_CARD_DETAIL_CHARS,
  WATCH_ACTIONS,
  WATCH_ANSWERS,
  WATCH_OPENS_BEFORE_MS,
  WATCH_OPEN_FOR_MS,
  WATCH_QUESTION,
  WATCH_SILENT_AFTER_MS,
  programmeById,
  watchCardId,
  type QueuedCard,
  type WatchCard,
} from '@wick/contracts';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import type { ToolContext } from '../context.js';
import { whenInWords } from '../watchSession.js';
import { registerInviteToWatch } from '../invite_to_watch.js';
import { registerGetWatchTogether } from '../get_watch_together.js';
import { registerJoinWatchTogether } from '../join_watch_together.js';
import { registerAnswerWatchTogether } from '../answer_watch_together.js';
import { registerWithdrawWatchInvitation } from '../withdraw_watch_invitation.js';
import { allowedContext } from './toolContext.js';
// The television's half of a session is the edge's own conditional updates, run here as they are deployed.
import {
  answerUpdate,
  askedUpdate,
  decisionUpdate,
  notNowUpdate,
  positionUpdate,
  startUpdate,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../../../../edge-device/lambda/watch-together.mjs';

/** Monday 12 October 2026, 10:00 in London (BST). */
const NOW = Date.UTC(2026, 9, 12, 9, 0);
/** Sunday 18 October 2026, 15:00 in London. */
const SUNDAY_AT_THREE = Date.UTC(2026, 9, 18, 14, 0);
const MIN = 60_000;
const SINTEL = programmeById('sintel')!;

async function connected(table: MemoryTable, ctx: ToolContext = allowedContext('hh-1'), clock: { now: number } = { now: NOW }) {
  const cards: QueuedCard[] = [];
  const sendCard = async (card: QueuedCard): Promise<void> => void cards.push(card);
  /** Cards taken back off the home's televisions, as [household, card]. */
  const withdrawn: [string, string][] = [];
  const withdrawCard = async (householdId: string, cardId: string): Promise<void> => void withdrawn.push([householdId, cardId]);
  const now = (): number => clock.now;
  const mcpServer = new McpServer({ name: 'test', version: '0.1.0' });
  registerInviteToWatch(mcpServer, table.ddb, ctx, sendCard, now);
  registerGetWatchTogether(mcpServer, table.ddb, ctx, now);
  registerJoinWatchTogether(mcpServer, table.ddb, ctx, sendCard, now);
  registerAnswerWatchTogether(mcpServer, table.ddb, ctx, sendCard, now);
  registerWithdrawWatchInvitation(mcpServer, table.ddb, ctx, withdrawCard, sendCard, now);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return {
      text: (result.content as { text: string }[])[0]!.text,
      structured: result.structuredContent as Record<string, unknown> | undefined,
      isError: result.isError === true,
    };
  };
  return { call, cards, withdrawn, clock };
}

const watchCard = (queued: QueuedCard | undefined): WatchCard => {
  if (queued?.card.type !== 'WATCH') throw new Error('not a watch card');
  return queued.card;
};

/** The television, as the edge hears it: each press and each position is the edge's own update against the table. */
function television(table: MemoryTable, sessionId: string) {
  const target = { table: 'wick', householdId: 'hh-1', sessionId };
  const apply = async (update: object | undefined): Promise<Record<string, { S?: string; N?: string }> | undefined> => {
    if (!update) return undefined;
    try {
      const out = (await table.ddb.send(new UpdateItemCommand(update as never))) as { Attributes?: Record<string, { S?: string; N?: string }> };
      return out.Attributes ?? {};
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') return undefined;
      throw err;
    }
  };
  return {
    accepts: (at: number) => apply(decisionUpdate({ ...target, accepted: true, at })),
    declines: (at: number) => apply(decisionUpdate({ ...target, accepted: false, at })),
    starts: (at: number) => apply(startUpdate({ ...target, at })),
    saysNotNow: (at: number) => apply(notNowUpdate({ ...target, at })),
    plays: (state: string, positionMs: number, now: number, contentId = 'sintel') =>
      apply(positionUpdate({ table: 'wick', householdId: 'hh-1', event: { t: 'watch_position', sessionId, state, positionMs, contentId, at: now }, now })),
    isAsked: (at: number) => apply(askedUpdate({ ...target, at })),
    answers: (answer: string, at: number) => apply(answerUpdate({ ...target, answer, at })),
  };
}

const INVITE = { programme: 'sintel', date: '2026-10-18', time: '15:00' };

/** An invitation Sarah made, already on the table. */
async function invited(table = createMemoryTable(), ctx: ToolContext = allowedContext('hh-1')) {
  const sarah = await connected(table, ctx);
  const sent = await sarah.call('invite_to_watch', INVITE);
  const sessionId = sent.structured!.sessionId as string;
  return { table, sarah, sessionId, tv: television(table, sessionId) };
}

describe('whenInWords — a day and a time as the household means them', () => {
  it('says the day, the date and the hour where the house is', () => {
    expect(whenInWords(SUNDAY_AT_THREE, 'Europe/London')).toBe('Sunday 18 October at 3 pm');
    expect(whenInWords(SUNDAY_AT_THREE + 30 * MIN, 'Europe/London')).toBe('Sunday 18 October at 3:30 pm');
    expect(whenInWords(Date.UTC(2026, 9, 18, 8, 5), 'Europe/London')).toBe('Sunday 18 October at 9:05 am');
    expect(whenInWords(SUNDAY_AT_THREE, 'America/New_York')).toBe('Sunday 18 October at 10 am');
  });
});

describe('invite_to_watch', () => {
  it('puts an invitation on the television, in the name of the person who is signed in', async () => {
    const { sarah, sessionId } = await invited();

    const card = watchCard(sarah.cards[0]);
    expect(sarah.cards).toHaveLength(1);
    expect(sarah.cards[0]).toMatchObject({ id: watchCardId('invite', sessionId), urgency: 'DEFERRED', shownCount: 0 });
    expect(card).toMatchObject({
      type: 'WATCH',
      householdId: 'hh-1',
      sessionId,
      withName: 'Sarah',
      headline: 'Sarah would like to watch a film with you.',
    });
    expect(card.detail).toContain('Sintel, on Sunday 18 October at 3 pm.');
    // She is told what saying yes means before she says it.
    expect(card.detail).toContain('see the film as you play it');
    expect(card.detail!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect(card.actions.map((a) => a.id)).toEqual([WATCH_ACTIONS.accept, WATCH_ACTIONS.decline]);
    // The invitation opens nothing: only the later "ready" card can start the film.
    expect(card.programmeId).toBeUndefined();
  });

  it('tells the person who asked what was sent, and when it is for', async () => {
    const { sarah } = await invited();
    const again = await connected(createMemoryTable());

    const sent = await again.call('invite_to_watch', INVITE);

    expect(sent.structured).toMatchObject({ invited: true, film: 'Sintel', startsAt: SUNDAY_AT_THREE, fromName: 'Sarah', when: 'Sunday 18 October at 3 pm' });
    expect(sarah.cards).toHaveLength(1);
  });

  it('uses the first name the resident knows them by, whatever a caller passes', async () => {
    const table = createMemoryTable();
    const { call, cards } = await connected(table, allowedContext('hh-1', { name: 'Sarah Whitfield' }));

    await call('invite_to_watch', { ...INVITE, fromName: 'Dr Evans' });

    expect(watchCard(cards[0]).withName).toBe('Sarah');
  });

  it('needs a real day and time, not one already gone or months away', async () => {
    const { call, cards } = await connected(createMemoryTable());

    expect((await call('invite_to_watch', { ...INVITE, time: 'three' })).text).toBe('I need a day and a time for that, like Sunday at three.');
    expect((await call('invite_to_watch', { ...INVITE, date: '2026-10-11' })).text).toBe('That time has already passed. Which day and time did you mean?');
    expect((await call('invite_to_watch', { ...INVITE, date: '2027-03-01' })).text).toMatch(/more than two months away/);
    expect(cards).toHaveLength(0);
  });

  it('can be for now: a time a few minutes gone is still now', async () => {
    const { call, cards } = await connected(createMemoryTable());

    const sent = await call('invite_to_watch', { programme: 'sintel', date: '2026-10-12', time: '09:55' });

    expect(sent.structured).toMatchObject({ invited: true });
    expect(cards).toHaveLength(1);
  });

  it('offers only the films Wick plays', async () => {
    const { call, cards } = await connected(createMemoryTable());

    const refused = await call('invite_to_watch', { ...INVITE, programme: 'casablanca' });

    expect(refused.isError).toBe(true);
    expect(cards).toHaveLength(0);
  });

  it('asks once: a second invitation while the first is open is not sent', async () => {
    const { sarah } = await invited();

    const second = await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

    expect(second.text).toBe("You have already asked Margaret to watch Sintel on Sunday 18 October at 3 pm. It is still waiting for an answer.");
    expect(sarah.cards).toHaveLength(1);
  });

  it('asks once even when two invitations are sent in the same moment', async () => {
    const table = createMemoryTable();
    const other = await connected(table);
    // The second invitation lands between this one's look and its write.
    let raced = false;
    const racing = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'TransactWriteItemsCommand' && !raced) {
          raced = true;
          await other.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });
        }
        return table.ddb.send(command as never);
      },
    };
    const sarah = await connected({ ...table, ddb: racing as never });

    const lost = await sarah.call('invite_to_watch', INVITE);

    expect(lost.text).toBe('You have already asked Margaret to watch Big Buck Bunny on Monday 19 October at 11 am. It is still waiting for an answer.');
    expect(sarah.cards).toHaveLength(0);
    expect(other.cards).toHaveLength(1);
    expect(table.rows('HH#hh-1').filter((row) => row.sk?.S?.startsWith('WATCH#'))).toHaveLength(1);
  });

  it('keeps one person’s open invitation from stopping another’s', async () => {
    const { table } = await invited();
    const tom = await connected(table, allowedContext('hh-1', { userId: 'u_tom', name: 'Tom' }));

    expect((await tom.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' })).structured).toMatchObject({ invited: true, fromName: 'Tom' });
  });

  it('can ask again once the first is settled', async () => {
    const { sarah, tv } = await invited();
    await tv.declines(NOW + MIN);

    const second = await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

    expect(second.structured).toMatchObject({ invited: true, film: 'Big Buck Bunny' });
    expect(sarah.cards).toHaveLength(2);
  });

  it('answers nobody the resident has not allowed', async () => {
    const waiting: ToolContext = { householdId: 'hh-1', userId: 'u_new', access: async () => ({ ok: false, reason: 'waiting', say: "Margaret hasn't allowed this yet." }) };
    const { call, cards } = await connected(createMemoryTable(), waiting);

    expect((await call('invite_to_watch', INVITE)).text).toBe("Margaret hasn't allowed this yet.");
    expect(cards).toHaveLength(0);
  });
});

describe('get_watch_together', () => {
  it('says plainly when nothing has been asked', async () => {
    const { call } = await connected(createMemoryTable());
    expect((await call('get_watch_together')).text).toBe("You haven't asked Margaret to watch anything.");
  });

  it('keeps the invitation between one day and the next: still waiting, then yes', async () => {
    const { table, sessionId, tv } = await invited();
    // Another day, another conversation: nothing is carried but the row.
    const tuesday = await connected(table, allowedContext('hh-1'), { now: NOW + 24 * 60 * MIN });

    expect((await tuesday.call('get_watch_together')).structured).toMatchObject({ sessionId, state: 'invited', film: 'Sintel', startsAt: SUNDAY_AT_THREE });

    await tv.accepts(NOW + 25 * 60 * MIN);

    expect((await tuesday.call('get_watch_together')).structured).toMatchObject({
      state: 'accepted',
      canSitDown: false,
      opensAt: SUNDAY_AT_THREE - WATCH_OPENS_BEFORE_MS,
    });
  });

  it('says when she would rather not', async () => {
    const { sarah, tv } = await invited();
    await tv.declines(NOW + MIN);

    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ state: 'declined' });
  });

  it('is over when the time has come and gone', async () => {
    const { table, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const late = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS });

    expect((await late.call('get_watch_together')).structured).toMatchObject({ state: 'over' });
  });

  it('shows a session only to the person who made it', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const tom = await connected(table, allowedContext('hh-1', { userId: 'u_tom', name: 'Tom' }), { now: SUNDAY_AT_THREE });

    expect((await tom.call('get_watch_together')).text).toBe("You haven't asked Margaret to watch anything.");
    expect((await tom.call('get_watch_together', { sessionId })).text).toBe("You haven't asked Margaret to watch anything.");
    expect((await tom.call('join_watch_together', { sessionId })).text).toBe("You haven't asked Margaret to watch anything.");
    expect((await tom.call('answer_watch_together', { sessionId, answer: 'loved_it' })).text).toBe("You haven't asked Margaret to watch anything.");
  });
});

describe('withdraw_watch_invitation — taking an invitation back', () => {
  it('takes an invitation she has not answered off the television', async () => {
    const { sarah, sessionId } = await invited();

    const taken = await sarah.call('withdraw_watch_invitation', { sessionId });

    // Nothing is said to her: she had not answered, and an invitation that is gone asks nothing.
    expect(taken.structured).toEqual({ withdrawn: true, told: false, sessionId, film: 'Sintel', when: 'Sunday 18 October at 3 pm' });
    expect(sarah.withdrawn).toEqual([['hh-1', watchCardId('invite', sessionId)]]);
    expect(sarah.cards).toHaveLength(1);
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ sessionId, state: 'withdrawn' });
  });

  it('takes back the newest one when none is named', async () => {
    const { sarah, sessionId } = await invited();

    expect((await sarah.call('withdraw_watch_invitation')).structured).toMatchObject({ withdrawn: true, sessionId });
  });

  it('cannot be answered afterwards: a press that was already on its way changes nothing', async () => {
    const { sarah, sessionId, tv } = await invited();
    await sarah.call('withdraw_watch_invitation', { sessionId });

    expect(await tv.accepts(NOW + MIN)).toBeUndefined();
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ state: 'withdrawn' });
  });

  it('leaves the way open for another invitation at once', async () => {
    const { sarah, sessionId } = await invited();
    await sarah.call('withdraw_watch_invitation', { sessionId });

    const second = await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

    expect(second.structured).toMatchObject({ invited: true, film: 'Big Buck Bunny' });
  });

  it('calls off one she has said yes to, and tells her so on her television', async () => {
    const { sarah, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);

    const called = await sarah.call('withdraw_watch_invitation', { sessionId });

    // She is expecting the film: it does not quietly disappear from her side.
    expect(called.structured).toEqual({ withdrawn: true, told: true, sessionId, film: 'Sintel', when: 'Sunday 18 October at 3 pm' });
    const told = sarah.cards.at(-1)!;
    expect(told.id).toBe(watchCardId('cancelled', sessionId));
    expect(told.urgency).toBe('DEFERRED');
    expect(watchCard(told)).toMatchObject({
      withName: 'Sarah',
      headline: 'Sarah cannot make the film after all.',
      detail: 'Sintel, on Sunday 18 October at 3 pm, is off. Sarah can ask you again for another time.',
      actions: [{ id: WATCH_ACTIONS.ok, label: 'All right', kind: 'primary' }],
    });
    expect(watchCard(told).detail!.length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ sessionId, state: 'cancelled' });
  });

  it('calls it off after sitting down too, and takes the card that was waiting for her to start it off the television', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });
    await sunday.call('join_watch_together', { sessionId });

    const called = await sunday.call('withdraw_watch_invitation', { sessionId });

    expect(called.structured).toMatchObject({ withdrawn: true, told: true });
    expect(sunday.withdrawn).toContainEqual(['hh-1', watchCardId('ready', sessionId)]);
    // A press on "Start the film" that was already on its way starts nothing anyone follows.
    expect(await tv.starts(SUNDAY_AT_THREE + MIN)).toBeUndefined();
    expect((await sunday.call('get_watch_together')).structured).toMatchObject({ state: 'cancelled' });
  });

  it('tells her once: called off twice, there is still one card', async () => {
    const { sarah, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const first = await sarah.call('withdraw_watch_invitation', { sessionId });
    const cards = sarah.cards.length;

    const second = await sarah.call('withdraw_watch_invitation', { sessionId });

    expect(second.structured).toEqual(first.structured);
    expect(sarah.cards).toHaveLength(cards);
  });

  it('lets another invitation be sent once one is called off', async () => {
    const { sarah, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    await sarah.call('withdraw_watch_invitation', { sessionId });

    expect((await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' })).structured).toMatchObject({ invited: true });
  });

  it('does not call off a film that has been started: there is nothing left to cancel but to stop watching', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });
    await sunday.call('join_watch_together', { sessionId });
    await tv.starts(SUNDAY_AT_THREE + MIN);
    const cards = sunday.cards.length;

    const called = await sunday.call('withdraw_watch_invitation', { sessionId });

    expect(called.text).toBe('Sintel has already been started on the television, so it cannot be called off.');
    expect(sunday.cards).toHaveLength(cards);
    expect((await sunday.call('get_watch_together')).structured).toMatchObject({ state: 'watching' });
  });

  it('has nothing to take back once she has said no, or the time has passed', async () => {
    const said = await invited();
    await said.tv.declines(NOW + MIN);
    expect((await said.sarah.call('withdraw_watch_invitation', { sessionId: said.sessionId })).text).toBe('Margaret has already said not this time. There is nothing to take back.');

    const gone = await invited();
    const late = await connected(gone.table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS });
    expect((await late.call('withdraw_watch_invitation', { sessionId: gone.sessionId })).text).toBe('The time for Sintel has passed. There is nothing to take back.');
    expect(late.withdrawn).toEqual([]);
  });

  it('calls it off, and tells her, when her yes came a moment first', async () => {
    const { table, sessionId, tv } = await invited();
    // Her "Yes, let’s." lands between this call's look and its write.
    let raced = false;
    const racing = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'UpdateItemCommand' && !raced) {
          raced = true;
          await tv.accepts(NOW + MIN);
        }
        return table.ddb.send(command as never);
      },
    };
    const sarah = await connected({ ...table, ddb: racing as never });

    const taken = await sarah.call('withdraw_watch_invitation', { sessionId });

    // She had said yes by the time it was taken back: it must not vanish unexplained.
    expect(taken.structured).toMatchObject({ withdrawn: true, told: true });
    expect(sarah.cards.at(-1)!.id).toBe(watchCardId('cancelled', sessionId));
  });

  it('says so when her no came a moment first', async () => {
    const { table, sessionId, tv } = await invited();
    let raced = false;
    const racing = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'UpdateItemCommand' && !raced) {
          raced = true;
          await tv.declines(NOW + MIN);
        }
        return table.ddb.send(command as never);
      },
    };
    const sarah = await connected({ ...table, ddb: racing as never });

    const taken = await sarah.call('withdraw_watch_invitation', { sessionId });

    expect(taken.text).toBe('Margaret has already said not this time. There is nothing to take back.');
    expect(sarah.withdrawn).toEqual([]);
  });

  it('can be asked twice: the card is taken off again and the answer is the same', async () => {
    const { sarah, sessionId } = await invited();
    const first = await sarah.call('withdraw_watch_invitation', { sessionId });

    const second = await sarah.call('withdraw_watch_invitation', { sessionId });

    expect(second.structured).toEqual(first.structured);
    expect(sarah.withdrawn).toHaveLength(2);
  });

  it('is only for the person who sent it', async () => {
    const { table, sessionId, sarah } = await invited();
    const tom = await connected(table, allowedContext('hh-1', { userId: 'u_tom', name: 'Tom' }));

    expect((await tom.call('withdraw_watch_invitation', { sessionId })).text).toBe("You haven't asked Margaret to watch anything.");
    expect(tom.withdrawn).toEqual([]);
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ state: 'invited' });
  });

  it('answers nobody the resident has not allowed', async () => {
    const waiting: ToolContext = { householdId: 'hh-1', userId: 'u_new', access: async () => ({ ok: false, reason: 'waiting', say: "Margaret hasn't allowed this yet." }) };
    const { call, withdrawn } = await connected(createMemoryTable(), waiting);

    expect((await call('withdraw_watch_invitation')).text).toBe("Margaret hasn't allowed this yet.");
    expect(withdrawn).toEqual([]);
  });

  it('leaves no seat to take', async () => {
    const { table, sessionId, sarah } = await invited();
    await sarah.call('withdraw_watch_invitation', { sessionId });
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });

    expect((await sunday.call('join_watch_together', { sessionId })).text).toBe('You took that invitation back. You can ask again whenever you like.');
  });
});

describe('join_watch_together — taking the seat', () => {
  it('waits for her answer', async () => {
    const { table, sessionId } = await invited();
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });

    expect((await sunday.call('join_watch_together', { sessionId })).text).toBe("Margaret hasn't answered the invitation yet. It is on the television.");
    expect(sunday.cards).toHaveLength(0);
  });

  it('is not open before its time', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const early = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE - WATCH_OPENS_BEFORE_MS - 1 });

    expect((await early.call('join_watch_together', { sessionId })).text).toBe(
      'It is not time yet. Sintel with Margaret is on Sunday 18 October at 3 pm; you can sit down from half an hour before.',
    );
    expect(early.cards).toHaveLength(0);
  });

  it('tells her television that someone is ready, with the one button that starts the film', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE - 5 * MIN });

    const seat = await sunday.call('join_watch_together', { sessionId });

    expect(seat.structured).toMatchObject({ sessionId, state: 'ready', stream: { url: SINTEL.streamUrl, durationMs: SINTEL.durationMs, attribution: SINTEL.attribution } });
    const card = watchCard(sunday.cards[0]);
    expect(sunday.cards[0]).toMatchObject({ id: watchCardId('ready', sessionId), urgency: 'DEFERRED' });
    expect(card.headline).toBe('Sarah is ready to watch Sintel with you.');
    // What pressing Start shares, said on the card that shares it.
    expect(card.detail).toBe('From when you start it, Sarah sees the film as you play it: where you pause, it pauses for Sarah too. Only this film, and only this time.');
    expect(card.actions.map((a) => [a.id, a.label])).toEqual([[WATCH_ACTIONS.start, 'Start the film'], [WATCH_ACTIONS.notNow, 'Not now']]);
    expect(card.programmeId).toBe('sintel');
    expect(card.followedUntil).toBe(SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS);
  });

  it('tells her once: sitting down again sends nothing more', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });

    await sunday.call('join_watch_together', { sessionId });
    const again = await sunday.call('join_watch_together', { sessionId });

    expect(again.structured).toMatchObject({ state: 'ready' });
    expect(sunday.cards).toHaveLength(1);
  });

  it('says so when she pressed "Not now"', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });
    await sunday.call('join_watch_together', { sessionId });

    await tv.saysNotNow(SUNDAY_AT_THREE + MIN);

    expect((await sunday.call('get_watch_together')).structured).toMatchObject({ state: 'passed' });
  });
});

describe('following the film', () => {
  /** Accepted, sat down to, and started by her press. */
  async function started() {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);
    const clock = { now: SUNDAY_AT_THREE };
    const sarah = await connected(table, allowedContext('hh-1'), clock);
    await sarah.call('join_watch_together', { sessionId });
    await tv.starts(SUNDAY_AT_THREE + MIN);
    clock.now = SUNDAY_AT_THREE + MIN;
    return { table, sessionId, tv, sarah, clock };
  }

  it('cannot be started by the television before anyone has sat down', async () => {
    const { table, sessionId, tv } = await invited();
    await tv.accepts(NOW + MIN);

    expect(await tv.starts(SUNDAY_AT_THREE)).toBeUndefined();
    expect(await tv.plays('PLAYING', 1_000, SUNDAY_AT_THREE)).toBeUndefined();
    const sunday = await connected(table, allowedContext('hh-1'), { now: SUNDAY_AT_THREE });
    expect((await sunday.call('get_watch_together', { sessionId })).structured).not.toHaveProperty('playback');
  });

  it('waits, with the film ready, until her player says where it is', async () => {
    const { sarah } = await started();

    const view = (await sarah.call('get_watch_together')).structured!;

    expect(view).toMatchObject({ state: 'watching', stream: { url: SINTEL.streamUrl } });
    expect(view).not.toHaveProperty('playback');
  });

  it('says where the film is and how long ago that was, by the server’s clock', async () => {
    const { sarah, tv, clock } = await started();
    await tv.plays('PLAYING', 61_000, clock.now);
    clock.now += 1_500;

    expect((await sarah.call('get_watch_together')).structured).toMatchObject({
      state: 'watching',
      playback: { state: 'PLAYING', positionMs: 61_000, ageMs: 1_500 },
    });
  });

  it('pauses where she pauses', async () => {
    const { sarah, tv, clock } = await started();
    await tv.plays('PLAYING', 61_000, clock.now);
    await tv.plays('PAUSED', 75_000, clock.now + 14_000);
    clock.now += 60_000;

    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ playback: { state: 'PAUSED', positionMs: 75_000 } });
  });

  it('waits rather than run on alone when her television has gone quiet, or is finding its place', async () => {
    const { sarah, tv, clock } = await started();
    await tv.plays('PLAYING', 61_000, clock.now);
    clock.now += WATCH_SILENT_AFTER_MS + 1;

    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ playback: { state: 'WAITING', positionMs: 61_000 } });

    await tv.plays('BUFFERING', 120_000, clock.now);
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ playback: { state: 'WAITING', positionMs: 120_000 } });
  });

  it('never learns of another film she plays', async () => {
    const { sarah, tv, clock } = await started();
    await tv.plays('PLAYING', 61_000, clock.now);

    expect(await tv.plays('PLAYING', 5_000, clock.now + 10_000, 'tears-of-steel')).toBeUndefined();

    clock.now += 10_000;
    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ playback: { positionMs: 61_000 } });
  });

  it('keeps nothing once the session is over', async () => {
    const { sarah, tv, clock } = await started();
    await tv.plays('PLAYING', 61_000, clock.now);

    expect(await tv.plays('PLAYING', 90_000, SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS)).toBeUndefined();

    clock.now = SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS;
    const view = (await sarah.call('get_watch_together')).structured!;
    expect(view).toMatchObject({ state: 'over' });
    expect(view).not.toHaveProperty('playback');
    expect(view).not.toHaveProperty('stream');
  });

  it('is not wound back by an event that arrives late', async () => {
    const { table, sessionId, sarah, clock } = await started();
    const send = (positionMs: number, at: number) =>
      table.ddb.send(new UpdateItemCommand(positionUpdate({
        table: 'wick', householdId: 'hh-1', now: clock.now,
        event: { t: 'watch_position', sessionId, state: 'PLAYING', positionMs, contentId: 'sintel', at },
      }) as never));

    await send(70_000, 2_000);
    await expect(send(65_000, 1_000)).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });

    expect((await sarah.call('get_watch_together')).structured).toMatchObject({ playback: { positionMs: 70_000 } });
  });

  describe('when she leaves the film before the end', () => {
    it('is no longer followed: the film was stopped, and there is nothing to keep up with', async () => {
      const { sarah, tv, clock } = await started();
      await tv.plays('PLAYING', 61_000, clock.now);
      await tv.plays('STOPPED', 95_000, clock.now + 34_000);
      clock.now += 40_000;

      const view = (await sarah.call('get_watch_together')).structured!;

      expect(view).toMatchObject({ state: 'stopped', film: 'Sintel' });
      expect(view).not.toHaveProperty('stream');
      expect(view).not.toHaveProperty('playback');
    });

    it('can be asked again at once, not when the three hours are up', async () => {
      const { sarah, tv, clock } = await started();
      await tv.plays('PLAYING', 61_000, clock.now);
      await tv.plays('STOPPED', 95_000, clock.now + 34_000);
      clock.now += 40_000;

      const again = await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

      expect(again.structured).toMatchObject({ invited: true, film: 'Big Buck Bunny' });
    });

    it('is final: nothing her television says afterwards is kept, and the session stays stopped', async () => {
      const { sarah, tv, clock } = await started();
      await tv.plays('PLAYING', 61_000, clock.now);
      await tv.plays('STOPPED', 95_000, clock.now + 34_000);

      // A television that went on reporting — a fault, or somebody holding its token.
      expect(await tv.plays('PLAYING', 120_000, clock.now + 60_000)).toBeUndefined();
      clock.now += 70_000;

      const view = (await sarah.call('get_watch_together')).structured!;
      expect(view).toMatchObject({ state: 'stopped' });
      expect(view).not.toHaveProperty('playback');
    });

    it('cannot be brought back beside the invitation that followed it: still one open at a time', async () => {
      const { sarah, sessionId, tv, clock } = await started();
      await tv.plays('PLAYING', 61_000, clock.now);
      await tv.plays('STOPPED', 95_000, clock.now + 34_000);
      clock.now += 40_000;
      await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

      await tv.plays('PLAYING', 120_000, clock.now + 20_000);
      clock.now += 30_000;

      expect((await sarah.call('get_watch_together', { sessionId })).structured).toMatchObject({ state: 'stopped' });
      const third = await sarah.call('invite_to_watch', { programme: 'tears-of-steel', date: '2026-10-20', time: '11:00' });
      expect(third.text).toContain('You have already asked Margaret to watch Big Buck Bunny');
    });

    it('is still being followed while it is only paused', async () => {
      const { sarah, tv, clock } = await started();
      await tv.plays('PAUSED', 95_000, clock.now);
      clock.now += 40_000;

      const again = await sarah.call('invite_to_watch', { programme: 'big-buck-bunny', date: '2026-10-19', time: '11:00' });

      expect((await sarah.call('get_watch_together')).structured).toMatchObject({ state: 'watching' });
      expect(again.text).toContain('You have already asked Margaret to watch Sintel');
    });

    it('is not what a film that played to its end is: that one keeps its question', async () => {
      const { sarah, tv, clock } = await started();
      await tv.plays('PLAYING', SINTEL.creditsPositionMs + 1_000, clock.now);
      await tv.isAsked(clock.now);
      await tv.plays('STOPPED', SINTEL.durationMs, clock.now + 60_000);
      clock.now += 70_000;

      expect((await sarah.call('get_watch_together')).structured).toMatchObject({ state: 'watched', question: 'What did you think of it?' });
    });
  });

  describe('at the credits', () => {
    async function atTheCredits() {
      const s = await started();
      const row = await s.tv.plays('PLAYING', SINTEL.creditsPositionMs, s.clock.now + 13 * MIN);
      s.clock.now += 13 * MIN;
      await s.tv.isAsked(s.clock.now);
      return { ...s, row };
    }

    it('the session row itself says where this film’s credits are, for the edge to ask by', async () => {
      const { row } = await atTheCredits();
      expect(row?.creditsMs).toEqual({ N: String(SINTEL.creditsPositionMs) });
      expect(row?.programmeTitle).toEqual({ S: 'Sintel' });
      expect(row?.invitedByName).toEqual({ S: 'Sarah' });
    });

    it('asks the family member the same one question, and keeps following through the credits', async () => {
      const { sarah } = await atTheCredits();

      expect((await sarah.call('get_watch_together')).structured).toMatchObject({
        state: 'watched',
        question: WATCH_QUESTION,
        answers: Object.entries(WATCH_ANSWERS).map(([key, text]) => ({ key, text })),
        playback: { state: 'PLAYING', positionMs: SINTEL.creditsPositionMs },
      });
    });

    it('will not take an answer before the film has got there', async () => {
      const { sarah, sessionId } = await started();

      expect((await sarah.call('answer_watch_together', { sessionId, answer: 'loved_it' })).text).toBe('The film has not reached its end yet.');
      expect(sarah.cards).toHaveLength(1); // the ready card, and nothing since
    });

    it('puts the family member’s answer on her television, under their name, in Wick’s words', async () => {
      const { sarah, sessionId } = await atTheCredits();

      const answered = await sarah.call('answer_watch_together', { sessionId, answer: 'loved_it' });

      expect(answered.structured).toMatchObject({ shown: true, by: 'Sarah', text: WATCH_ANSWERS.loved_it });
      const queued = sarah.cards.at(-1);
      const card = watchCard(queued);
      expect(queued).toMatchObject({ id: watchCardId('answer', sessionId), urgency: 'DEFERRED' });
      expect(card.headline).toBe('Sarah says: “I loved it.”');
      expect(card.detail).toBe('About Sintel, which you watched together.');
      expect(card.actions.map((a) => a.id)).toEqual([WATCH_ACTIONS.ok]);
    });

    it('takes one answer from each of them, and tells each what the other said', async () => {
      const { sarah, sessionId, tv, clock } = await atTheCredits();
      await tv.answers('all_right', clock.now + 5_000);
      await sarah.call('answer_watch_together', { sessionId, answer: 'loved_it' });

      const second = await sarah.call('answer_watch_together', { sessionId, answer: 'not_for_me' });
      const view = (await sarah.call('get_watch_together')).structured!;

      expect(second.text).toBe('You have already answered: “I loved it.”');
      expect(view).toMatchObject({ state: 'watched', yourAnswer: WATCH_ANSWERS.loved_it, theirAnswer: WATCH_ANSWERS.all_right });
      // Answered: the buttons are not offered again.
      expect(view).not.toHaveProperty('answers');
      expect(sarah.cards.filter((c) => c.id === watchCardId('answer', sessionId))).toHaveLength(1);
    });

    it('cannot be answered with a sentence somebody wrote', async () => {
      const { sarah, sessionId } = await atTheCredits();

      const refused = await sarah.call('answer_watch_together', { sessionId, answer: 'It was boring, sell the television.' });

      expect(refused.isError).toBe(true);
      expect(sarah.cards.filter((c) => c.id === watchCardId('answer', sessionId))).toHaveLength(0);
    });

    it('remembers what each of them said after the session has closed', async () => {
      const { sarah, sessionId, tv, clock } = await atTheCredits();
      await tv.answers('loved_it', clock.now + 5_000);
      await sarah.call('answer_watch_together', { sessionId, answer: 'loved_it' });
      clock.now = SUNDAY_AT_THREE + WATCH_OPEN_FOR_MS + MIN;

      const view = (await sarah.call('get_watch_together')).structured!;

      expect(view).toMatchObject({ state: 'watched', yourAnswer: WATCH_ANSWERS.loved_it, theirAnswer: WATCH_ANSWERS.loved_it });
      expect(view).not.toHaveProperty('playback');
      expect(view).not.toHaveProperty('stream');
    });
  });
});
