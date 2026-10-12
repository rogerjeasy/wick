import { describe, expect, it, vi } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import type { Difference } from '../../../rhythm/different.js';
import { askAboutDifferences, buildTellCard, differenceId, tellRowItem, type AskDeps, type TellRow } from '../ask.js';
import { handleTellAnswer, type AnswerDeps } from '../answer.js';

const NOW = Date.UTC(2026, 9, 9, 14);
const FRIDAY_NINE = Date.UTC(2026, 9, 9, 9);

const missed: Difference = {
  kind: 'missed_visit',
  factClass: 'PRESENCE',
  sentence: 'Maria usually comes on Friday mornings. There has been no visit today.',
  lasting: 'Maria usually comes on Friday mornings. There was no visit on Friday.',
  at: FRIDAY_NINE,
  personId: 'maria',
};
const quiet: Difference = {
  kind: 'door_quiet',
  factClass: 'DOOR_EVENT',
  sentence: 'Nobody has come to the door today. By this time on a Friday there are usually about 3.',
  lasting: 'Nobody had come to the door by 3:00 pm on Friday. By that time on a Friday there are usually about 3.',
  at: Date.UTC(2026, 9, 9),
};

describe('differenceId', () => {
  it('is the kind, who it is about, and the day — so the same difference is the same question', () => {
    expect(differenceId(missed)).toBe('missed_visit-maria-2026-10-09');
    expect(differenceId({ ...missed, sentence: 'worded another way', lasting: 'and another' })).toBe('missed_visit-maria-2026-10-09');
    expect(differenceId(quiet)).toBe('door_quiet-2026-10-09');
  });

  it('is a different question on another day, or about another person', () => {
    expect(differenceId({ ...missed, at: FRIDAY_NINE + 4 * 86_400_000 })).toBe('missed_visit-maria-2026-10-13');
    expect(differenceId({ ...missed, personId: 'tom' })).toBe('missed_visit-tom-2026-10-09');
  });

  it('carries nothing that could not be part of a key or a card id', () => {
    expect(differenceId({ ...missed, personId: 'member-u1#2026/10 09' })).toBe('missed_visit-member-u1_2026_10_09-2026-10-09');
  });
});

describe('buildTellCard', () => {
  const card = buildTellCard({ householdId: 'hh-1', differenceId: 'missed_visit-maria-2026-10-09', sentence: missed.lasting, who: 'Sarah', now: NOW, correlationId: 'corr-1' });

  it('asks the question, and shows the very sentence the family would be told', () => {
    expect(card).toEqual({
      id: 'tell-missed_visit-maria-2026-10-09',
      urgency: 'DEFERRED',
      queuedAt: NOW,
      shownCount: 0,
      card: {
        type: 'TELL',
        id: 'tell-missed_visit-maria-2026-10-09',
        householdId: 'hh-1',
        correlationId: 'corr-1',
        createdAt: NOW,
        headline: 'Shall I tell Sarah?',
        detail: 'Maria usually comes on Friday mornings. There was no visit on Friday.',
        actions: [
          { id: 'tell_family', label: 'Tell Sarah', kind: 'primary' },
          { id: 'keep_private', label: 'Keep it to myself', kind: 'dismiss' },
        ],
      },
    });
  });

  it('waits for a natural break like any other card: it is never urgent', () => {
    expect(card.urgency).toBe('DEFERRED');
    expect(card.expiresAt).toBeUndefined();
  });
});

describe('tellRowItem', () => {
  it('is one row per difference, holding what the family would be told and nothing more', () => {
    const row: TellRow = { householdId: 'hh-1', differenceId: 'missed_visit-maria-2026-10-09', kind: 'missed_visit', factClass: 'PRESENCE', sentence: missed.lasting, at: FRIDAY_NINE, askedAt: NOW, weeksObserved: 6 };

    expect(tellRowItem(row)).toEqual({
      pk: { S: 'HH#hh-1' },
      sk: { S: 'TELL#missed_visit-maria-2026-10-09' },
      differenceId: { S: 'missed_visit-maria-2026-10-09' },
      kind: { S: 'missed_visit' },
      factClass: { S: 'PRESENCE' },
      sentence: { S: 'Maria usually comes on Friday mornings. There was no visit on Friday.' },
      at: { N: String(FRIDAY_NINE) },
      askedAt: { N: String(NOW) },
      weeksObserved: { N: '6' },
      ttl: { N: String(Math.floor(NOW / 1000) + 14 * 86_400) },
    });
  });
});

const sarah = { userId: 'u-sarah', name: 'Sarah Whitfield' };
const tom = { userId: 'u-tom', name: 'Tom' };

function askDeps(over: Partial<AskDeps> = {}): AskDeps {
  return {
    loadDifferences: vi.fn(async () => ({ weeksObserved: 6, differences: [missed] })),
    listFamily: vi.fn(async () => [sarah]),
    claimOnce: vi.fn(async (_row: TellRow) => true),
    release: vi.fn(async () => {}),
    sendCard: vi.fn(async (_card: QueuedCard) => {}),
    now: () => NOW,
    newCorrelationId: () => 'corr-1',
    ...over,
  };
}

describe('askAboutDifferences — the resident is asked before anyone is told', () => {
  it('files the question, then puts it on the television, naming who would be told', async () => {
    const d = askDeps();

    expect(await askAboutDifferences('hh-1', d)).toEqual(['missed_visit-maria-2026-10-09']);

    expect(d.claimOnce).toHaveBeenCalledWith({
      householdId: 'hh-1', differenceId: 'missed_visit-maria-2026-10-09', kind: 'missed_visit', factClass: 'PRESENCE',
      sentence: missed.lasting, at: FRIDAY_NINE, askedAt: NOW, weeksObserved: 6,
    });
    const sent = vi.mocked(d.sendCard).mock.calls[0]![0];
    expect(sent.card).toMatchObject({ type: 'TELL', headline: 'Shall I tell Sarah?', detail: missed.lasting });
  });

  it('asks about "the family" when more than one person would be told', async () => {
    const d = askDeps({ listFamily: vi.fn(async () => [sarah, tom]) });

    await askAboutDifferences('hh-1', d);

    const sent = vi.mocked(d.sendCard).mock.calls[0]![0];
    expect(sent.card).toMatchObject({ headline: 'Shall I tell the family?', actions: [{ label: 'Tell the family' }, { label: 'Keep it to myself' }] });
  });

  it('asks once: a difference already asked about is never put on the television again', async () => {
    const d = askDeps({ claimOnce: vi.fn(async () => false) });

    expect(await askAboutDifferences('hh-1', d)).toEqual([]);
    expect(d.sendCard).not.toHaveBeenCalled();
  });

  it('asks about each difference separately', async () => {
    const d = askDeps({ loadDifferences: vi.fn(async () => ({ weeksObserved: 6, differences: [missed, quiet] })) });

    expect(await askAboutDifferences('hh-1', d)).toEqual(['missed_visit-maria-2026-10-09', 'door_quiet-2026-10-09']);
    expect(d.sendCard).toHaveBeenCalledTimes(2);
  });

  it('asks nothing when there is nobody to tell — and does not even look for differences', async () => {
    const d = askDeps({ listFamily: vi.fn(async () => []) });

    expect(await askAboutDifferences('hh-1', d)).toEqual([]);
    expect(d.loadDifferences).not.toHaveBeenCalled();
    expect(d.claimOnce).not.toHaveBeenCalled();
  });

  it('asks nothing when the resident keeps the shape of the week private, or nothing is different', async () => {
    const privateWeek = askDeps({ loadDifferences: vi.fn(async () => undefined) });
    const usualDay = askDeps({ loadDifferences: vi.fn(async () => ({ weeksObserved: 6, differences: [] })) });

    expect(await askAboutDifferences('hh-1', privateWeek)).toEqual([]);
    expect(await askAboutDifferences('hh-1', usualDay)).toEqual([]);
    expect(privateWeek.sendCard).not.toHaveBeenCalled();
    expect(usualDay.sendCard).not.toHaveBeenCalled();
  });

  it('takes the question back if the card could not be sent, so it is asked next time instead of never', async () => {
    const d = askDeps({ sendCard: vi.fn(async () => { throw new Error('table down'); }) });

    expect(await askAboutDifferences('hh-1', d)).toEqual([]);
    expect(d.release).toHaveBeenCalledWith('hh-1', 'missed_visit-maria-2026-10-09');
  });
});

const press = (action: string, cardId = 'tell-missed_visit-maria-2026-10-09') => ({ householdId: 'hh-1', deviceId: 'wick-tv', cardId, action, at: NOW });

function answerDeps(over: Partial<AnswerDeps> = {}): AnswerDeps {
  return {
    recordAnswer: vi.fn(async () => true),
    listFamily: vi.fn(async () => [sarah, tom]),
    nudge: vi.fn(async (_userIds: readonly string[]) => {}),
    withdraw: vi.fn(async (_householdId: string, _cardId: string) => {}),
    now: () => NOW + 60_000,
    ...over,
  };
}

describe('handleTellAnswer — the resident’s press is the only thing that lets a difference out', () => {
  it('records "tell", then nudges the browsers of everyone the resident allows', async () => {
    const d = answerDeps();

    expect(await handleTellAnswer(press('tell_family'), d)).toBe('told');

    expect(d.recordAnswer).toHaveBeenCalledWith('hh-1', 'missed_visit-maria-2026-10-09', 'tell', NOW + 60_000);
    expect(d.nudge).toHaveBeenCalledWith(['u-sarah', 'u-tom']);
  });

  it('records "keep", and tells nobody anything', async () => {
    const d = answerDeps();

    expect(await handleTellAnswer(press('keep_private'), d)).toBe('kept');

    expect(d.recordAnswer).toHaveBeenCalledWith('hh-1', 'missed_visit-maria-2026-10-09', 'keep', NOW + 60_000);
    expect(d.listFamily).not.toHaveBeenCalled();
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('takes the first answer only: a second press, or one for a question never asked, changes nothing and nudges nobody', async () => {
    const d = answerDeps({ recordAnswer: vi.fn(async () => false) });

    expect(await handleTellAnswer(press('tell_family'), d)).toBe('not_open');
    expect(d.nudge).not.toHaveBeenCalled();
  });

  it('leaves every other press alone', async () => {
    const d = answerDeps();

    expect(await handleTellAnswer(press('tell_family', 'door-abc'), d)).toBe('ignored');
    expect(await handleTellAnswer(press('dismiss'), d)).toBe('ignored');
    expect(await handleTellAnswer({ cardId: 'tell-x' }, d)).toBe('ignored');
    expect(d.recordAnswer).not.toHaveBeenCalled();
  });

  it('takes the question off the home’s other televisions once it is answered — whichever answer it was', async () => {
    for (const action of ['tell_family', 'keep_private']) {
      const d = answerDeps();

      await handleTellAnswer(press(action), d);

      expect(d.withdraw).toHaveBeenCalledWith('hh-1', 'tell-missed_visit-maria-2026-10-09');
    }
  });

  it('withdraws nothing for a press that answered nothing', async () => {
    const d = answerDeps({ recordAnswer: vi.fn(async () => false) });

    await handleTellAnswer(press('tell_family'), d);

    expect(d.withdraw).not.toHaveBeenCalled();
  });

  it('has still answered when the card cannot be withdrawn: a late press elsewhere changes nothing anyway', async () => {
    const d = answerDeps({ withdraw: vi.fn(async () => { throw new Error('television gone'); }) });

    expect(await handleTellAnswer(press('tell_family'), d)).toBe('told');
    expect(d.nudge).toHaveBeenCalled();
    expect(await handleTellAnswer(press('keep_private'), answerDeps({ withdraw: vi.fn(async () => { throw new Error('television gone'); }) }))).toBe('kept');
  });

  it('has still told when the nudge fails: the family reads it when they next open Wick', async () => {
    const d = answerDeps({ nudge: vi.fn(async () => { throw new Error('push keys missing'); }) });

    expect(await handleTellAnswer(press('tell_family'), d)).toBe('told');
  });
});
