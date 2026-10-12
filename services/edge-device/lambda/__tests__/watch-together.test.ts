import { describe, expect, it } from 'vitest';
import { WATCH_ACTIONS, WATCH_ANSWERS, WATCH_QUESTION, WATCH_SK_PREFIX, watchCardId, watchCardOf } from '@wick/contracts';
import {
  ANSWERS,
  QUESTION,
  answerUpdate,
  askedUpdate,
  buildQuestionCard,
  decisionUpdate,
  notNowUpdate,
  positionUpdate,
  shouldAsk,
  startUpdate,
  watchPress,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../watch-together.mjs';

const NOW = 1_790_900_000_000;
const KEY = { pk: { S: 'HH#margaret' }, sk: { S: `${WATCH_SK_PREFIX}s-1` } };

const position = (over: Record<string, unknown> = {}) => ({
  t: 'watch_position',
  sessionId: 's-1',
  state: 'PLAYING',
  positionMs: 61_000,
  contentId: 'sintel',
  at: NOW - 400,
  ...over,
});

describe('what the television can press, held to the contract', () => {
  it('offers the same three answers, in the same words, as the family is offered', () => {
    expect(ANSWERS).toEqual(WATCH_ANSWERS);
    expect(QUESTION).toBe(WATCH_QUESTION);
  });
});

describe('watchPress — what a press on one of a session’s cards means', () => {
  it('reads yes and no from the invitation', () => {
    expect(watchPress(watchCardId('invite', 's-1'), WATCH_ACTIONS.accept)).toEqual({ sessionId: 's-1', press: 'accept' });
    expect(watchPress(watchCardId('invite', 's-1'), WATCH_ACTIONS.decline)).toEqual({ sessionId: 's-1', press: 'decline' });
  });

  it('reads the start of the film, and "not now", from the card that says someone is ready', () => {
    expect(watchPress(watchCardId('ready', 's-1'), WATCH_ACTIONS.start)).toEqual({ sessionId: 's-1', press: 'start' });
    expect(watchPress(watchCardId('ready', 's-1'), WATCH_ACTIONS.notNow)).toEqual({ sessionId: 's-1', press: 'not_now' });
  });

  it('reads an answer from the question, and only one Wick offered', () => {
    expect(watchPress(watchCardId('question', 's-1'), 'loved_it')).toEqual({ sessionId: 's-1', press: 'answer', answer: 'loved_it' });
    expect(watchPress(watchCardId('question', 's-1'), 'I hated it')).toBeUndefined();
    expect(watchPress(watchCardId('question', 's-1'), 'toString')).toBeUndefined();
  });

  it('is nothing for a button on the wrong card, or for any other card', () => {
    expect(watchPress(watchCardId('invite', 's-1'), WATCH_ACTIONS.start)).toBeUndefined();
    expect(watchPress(watchCardId('ready', 's-1'), WATCH_ACTIONS.accept)).toBeUndefined();
    expect(watchPress(watchCardId('answer', 's-1'), WATCH_ACTIONS.ok)).toBeUndefined();
    expect(watchPress('note-abc', WATCH_ACTIONS.accept)).toBeUndefined();
    expect(watchPress('watch-invite-a b', WATCH_ACTIONS.accept)).toBeUndefined();
    expect(watchPress(undefined, undefined)).toBeUndefined();
  });
});

describe('decisionUpdate — the resident’s yes or no', () => {
  it('answers an invitation still waiting, and no other', () => {
    const update = decisionUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', accepted: true, at: NOW });

    expect(update.Key).toEqual(KEY);
    expect(update.ConditionExpression).toBe('#status = :invited');
    expect(update.ExpressionAttributeValues[':status']).toEqual({ S: 'accepted' });
    expect(update.ExpressionAttributeValues[':invited']).toEqual({ S: 'invited' });
    expect(update.ExpressionAttributeValues[':at']).toEqual({ N: String(NOW) });
  });

  it('records a no as a no', () => {
    const update = decisionUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', accepted: false, at: NOW });
    expect(update.ExpressionAttributeValues[':status']).toEqual({ S: 'declined' });
  });
});

describe('startUpdate — "Start the film" is where following begins', () => {
  it('starts only a session she accepted, that someone has sat down to, and that is not over', () => {
    const update = startUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', at: NOW });

    expect(update.Key).toEqual(KEY);
    expect(update.UpdateExpression).toBe('SET startedAt = if_not_exists(startedAt, :at)');
    expect(update.ConditionExpression).toBe('#status = :accepted AND attribute_exists(joinedAt) AND attribute_not_exists(passedAt) AND closesAt > :at');
  });
});

describe('notNowUpdate — she would rather not, just now', () => {
  it('closes a session that has not started', () => {
    const update = notNowUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', at: NOW });
    expect(update.UpdateExpression).toBe('SET passedAt = :at');
    expect(update.ConditionExpression).toBe('#status = :accepted AND attribute_not_exists(startedAt) AND attribute_not_exists(passedAt)');
  });
});

describe('positionUpdate — where the film is, kept only when the rule allows it', () => {
  it('keeps the position against a session she started, for the film it names, while it is open', () => {
    const update = positionUpdate({ table: 'wick', householdId: 'margaret', event: position(), now: NOW });

    expect(update.Key).toEqual(KEY);
    expect(update.ConditionExpression).toBe(
      'attribute_exists(startedAt) AND attribute_not_exists(leftAt) AND programmeId = :content AND closesAt > :now AND (attribute_not_exists(pbDeviceAt) OR pbDeviceAt <= :deviceAt)',
    );
    // A film that is playing has not been left.
    expect(update.UpdateExpression).not.toContain('leftAt');
    expect(update.ExpressionAttributeValues).toEqual({
      ':state': { S: 'PLAYING' },
      ':position': { N: '61000' },
      ':now': { N: String(NOW) },
      ':deviceAt': { N: String(NOW - 400) },
      ':content': { S: 'sintel' },
    });
    // What is on the row afterwards decides whether the question is due.
    expect(update.ReturnValues).toBe('ALL_NEW');
  });

  it('stamps the server’s own clock, so two clocks that disagree cannot move the film', () => {
    const update = positionUpdate({ table: 'wick', householdId: 'margaret', event: position({ at: NOW + 3_600_000 }), now: NOW });
    expect(update.UpdateExpression).toContain('pbAt = :now');
  });

  it('marks the film as left when her player stops, by the server’s clock, and keeps nothing after that', () => {
    const update = positionUpdate({ table: 'wick', householdId: 'margaret', event: position({ state: 'STOPPED' }), now: NOW });

    // Stamped with the position that says so, in one write: the row cannot say STOPPED without it.
    expect(update.UpdateExpression).toContain('leftAt = :now');
    // And the same condition every position carries is what then refuses the next one: leaving is final.
    expect(update.ConditionExpression).toContain('attribute_not_exists(leftAt)');
  });

  it('is nothing for an event that is not a position', () => {
    for (const bad of [
      position({ sessionId: 'a b' }),
      position({ sessionId: undefined }),
      position({ state: 'REWINDING' }),
      position({ positionMs: -1 }),
      position({ positionMs: '61000' }),
      position({ positionMs: Number.NaN }),
      position({ contentId: '' }),
      position({ at: 'now' }),
    ]) {
      expect(positionUpdate({ table: 'wick', householdId: 'margaret', event: bad, now: NOW })).toBeUndefined();
    }
  });
});

describe('shouldAsk — the question comes at the credits, once', () => {
  const row = (over: Record<string, unknown> = {}) => ({ ...KEY, creditsMs: { N: '744000' }, pbPositionMs: { N: '744000' }, pbState: { S: 'PLAYING' }, ...over });

  it('is due when the film has reached its credits', () => {
    expect(shouldAsk(row())).toBe(true);
    expect(shouldAsk(row({ pbPositionMs: { N: '800000' } }))).toBe(true);
  });

  it('is not due before them, or when it has been asked', () => {
    expect(shouldAsk(row({ pbPositionMs: { N: '743999' } }))).toBe(false);
    expect(shouldAsk(row({ askedAt: { N: String(NOW) } }))).toBe(false);
  });

  it('is not due on a row that does not say where the credits are', () => {
    expect(shouldAsk(row({ creditsMs: undefined }))).toBe(false);
    expect(shouldAsk(undefined)).toBe(false);
  });
});

describe('askedUpdate — asked once, whoever gets there first', () => {
  it('claims the question only if nobody has', () => {
    const update = askedUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', at: NOW });
    expect(update.UpdateExpression).toBe('SET askedAt = :at');
    expect(update.ConditionExpression).toBe('attribute_not_exists(askedAt)');
  });
});

describe('buildQuestionCard — one question, three buttons, at the credits', () => {
  const row = { ...KEY, sessionId: { S: 's-1' }, programmeTitle: { S: 'Sintel' }, invitedByName: { S: 'Sarah' } };

  it('asks about the film by name, in Wick’s words, and waits for a natural break like any other card', () => {
    const queued = buildQuestionCard({ householdId: 'margaret', item: row, now: NOW });

    expect(queued.id).toBe(watchCardId('question', 's-1'));
    expect(watchCardOf(queued.id)).toEqual({ kind: 'question', sessionId: 's-1' });
    expect(queued.urgency).toBe('DEFERRED');
    expect(queued.shownCount).toBe(0);
    expect(queued.card).toMatchObject({
      type: 'WATCH',
      id: queued.id,
      householdId: 'margaret',
      sessionId: 's-1',
      withName: 'Sarah',
      headline: 'That was Sintel, with Sarah.',
      detail: WATCH_QUESTION,
    });
  });

  it('offers exactly the three answers, each button carrying its key', () => {
    const { card } = buildQuestionCard({ householdId: 'margaret', item: row, now: NOW });
    expect(card.actions.map((a: { id: string; label: string }) => [a.id, a.label])).toEqual(Object.entries(WATCH_ANSWERS));
    expect(card.actions).toHaveLength(3);
  });
});

describe('answerUpdate — what she thought of it', () => {
  it('keeps her first answer to a question that was asked', () => {
    const update = answerUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', answer: 'loved_it', at: NOW });

    expect(update.Key).toEqual(KEY);
    expect(update.ConditionExpression).toBe('attribute_exists(askedAt) AND attribute_not_exists(residentAnswer)');
    expect(update.ExpressionAttributeValues).toEqual({ ':answer': { S: 'loved_it' }, ':at': { N: String(NOW) } });
  });

  it('refuses an answer Wick did not offer', () => {
    expect(() => answerUpdate({ table: 'wick', householdId: 'margaret', sessionId: 's-1', answer: 'I hated it', at: NOW })).toThrow();
  });
});
