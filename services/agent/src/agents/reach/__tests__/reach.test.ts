import { describe, expect, it, vi, type Mock } from 'vitest';
import { PUSH_KINDS, REACH_ACTIONS, REACH_WAIT_MS, reachCardId, type QueuedCard, type ReachPerson, type ReachRequest } from '@wick/contracts';
import { handleReachAsk, type ReachAskDeps } from '../ask.js';
import { handleReachDue, type ReachDueDeps } from '../due.js';
import { reachDueEvent, reachDueSchedule } from '../timer.js';
import { reachFromItem, reachItem, reachStore } from '../../../store/reaches.js';

const NOW = Date.UTC(2026, 9, 13, 14, 0);
const REACH_ID = String(NOW - 4_000);

const sarah = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' as const, since: 10 };
const david = { userId: 'u_david', name: 'David', role: 'family' as const, since: 20 };
const tom = { userId: 'u_tom', name: 'Tom', role: 'neighbour' as const, since: 5 };
const person = ({ userId, name, role }: ReachPerson): ReachPerson => ({ userId, name, role });

const press = (action: string, over: Record<string, unknown> = {}) => ({ householdId: 'hh-1', deviceId: 'tv-1', cardId: reachCardId(REACH_ID), action, at: NOW - 500, ...over });

const headline = (card: QueuedCard | undefined): string | undefined => (card?.card.type === 'REACH' ? card.card.headline : undefined);

/** The same dependencies, each one a spy that can be asked what it was called with. */
type Spies<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K] };

function askDeps(over: Partial<Spies<ReachAskDeps>> = {}): Spies<ReachAskDeps> {
  return {
    listCircle: vi.fn<ReachAskDeps['listCircle']>(async () => [tom, david, sarah]),
    claimOnce: vi.fn<ReachAskDeps['claimOnce']>(async () => true),
    sendCard: vi.fn<ReachAskDeps['sendCard']>(async () => {}),
    nudge: vi.fn<ReachAskDeps['nudge']>(async () => {}),
    schedule: vi.fn<ReachAskDeps['schedule']>(async () => {}),
    now: vi.fn<ReachAskDeps['now']>(() => NOW),
    ...over,
  };
}

describe('her press: "Yes, ask Sarah"', () => {
  it('files the request, tells her who was asked, tells that one person, and sets the three minutes going', async () => {
    const deps = askDeps();
    expect(await handleReachAsk(press(REACH_ACTIONS.ring), deps)).toBe('asked');

    expect(deps.claimOnce).toHaveBeenCalledWith({
      householdId: 'hh-1',
      reachId: REACH_ID,
      kind: 'ring',
      askedAt: NOW,
      order: [person(sarah), person(david), person(tom)],
      asked: 1,
    });
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('Sarah has been asked to ring you.');
    expect(deps.sendCard.mock.calls[0]![0].id).toBe(reachCardId(REACH_ID));
    // One person. The others are not told there is a request at all.
    expect(deps.nudge.mock.calls).toEqual([[['u_sarah'], PUSH_KINDS.reachRing]]);
    expect(deps.schedule.mock.calls).toEqual([[{ householdId: 'hh-1', reachId: REACH_ID, step: 1, at: NOW + REACH_WAIT_MS }]]);
  });

  it('reads her circle at the press: somebody she has since removed is not in it', async () => {
    const deps = askDeps({ listCircle: vi.fn(async () => [david]) });
    await handleReachAsk(press(REACH_ACTIONS.ring), deps);
    expect(deps.claimOnce.mock.calls[0]![0].order).toEqual([person(david)]);
    expect(deps.nudge.mock.calls[0]![0]).toEqual(['u_david']);
  });

  it('asks once, however often the press arrives', async () => {
    const deps = askDeps({ claimOnce: vi.fn(async () => false) });
    expect(await handleReachAsk(press(REACH_ACTIONS.ring), deps)).toBe('duplicate');
    expect(deps.sendCard).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it('says so, and files nothing, when there is nobody to ask', async () => {
    const deps = askDeps({ listCircle: vi.fn(async () => []) });
    expect(await handleReachAsk(press(REACH_ACTIONS.ring), deps)).toBe('nobody');
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('There is nobody Wick can ask just now.');
    expect(deps.claimOnce).not.toHaveBeenCalled();
    expect(deps.nudge).not.toHaveBeenCalled();
  });

  it('still asks when the card cannot be drawn, the nudge fails, or the timer cannot be set', async () => {
    for (const broken of ['sendCard', 'nudge', 'schedule'] as const) {
      const deps = askDeps({ [broken]: vi.fn(async () => { throw new Error('down'); }) });
      expect(await handleReachAsk(press(REACH_ACTIONS.ring), deps)).toBe('asked');
      expect(deps.claimOnce).toHaveBeenCalledTimes(1);
      if (broken !== 'nudge') expect(deps.nudge).toHaveBeenCalledTimes(1);
    }
  });
});

describe('her press: "Just say hello"', () => {
  it('tells the first person exactly that, and nobody after them', async () => {
    const deps = askDeps();
    expect(await handleReachAsk(press(REACH_ACTIONS.hello), deps)).toBe('asked');
    expect(deps.claimOnce.mock.calls[0]![0]).toMatchObject({ kind: 'hello', order: [person(sarah)], asked: 1 });
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('Sarah has been told you said hello.');
    expect(deps.nudge.mock.calls).toEqual([[['u_sarah'], PUSH_KINDS.reachHello]]);
    expect(deps.schedule).not.toHaveBeenCalled();
  });
});

describe('a press that is not hers to make', () => {
  it('is ignored: the way out, another card’s button, a card that is not a request, or no household', async () => {
    for (const detail of [
      press(REACH_ACTIONS.notNow),
      press('tell_family'),
      press(REACH_ACTIONS.ring, { cardId: 'light' }),
      press(REACH_ACTIONS.ring, { cardId: 'reach-not-a-moment' }),
      press(REACH_ACTIONS.ring, { householdId: '' }),
    ]) {
      const deps = askDeps();
      expect(await handleReachAsk(detail, deps)).toBe('ignored');
      expect(deps.listCircle).not.toHaveBeenCalled();
      expect(deps.claimOnce).not.toHaveBeenCalled();
    }
  });
});

const underWay = (over: Partial<ReachRequest> = {}): ReachRequest => ({
  householdId: 'hh-1',
  reachId: REACH_ID,
  kind: 'ring',
  askedAt: NOW - REACH_WAIT_MS,
  order: [person(sarah), person(david), person(tom)],
  asked: 1,
  ...over,
});

function dueDeps(request: ReachRequest | undefined, over: Partial<Spies<ReachDueDeps>> = {}): Spies<ReachDueDeps> {
  return {
    load: vi.fn<ReachDueDeps['load']>(async () => request),
    listCircle: vi.fn<ReachDueDeps['listCircle']>(async () => [tom, david, sarah]),
    advance: vi.fn<ReachDueDeps['advance']>(async () => true),
    finish: vi.fn<ReachDueDeps['finish']>(async () => true),
    sendCard: vi.fn<ReachDueDeps['sendCard']>(async () => {}),
    nudge: vi.fn<ReachDueDeps['nudge']>(async () => {}),
    schedule: vi.fn<ReachDueDeps['schedule']>(async () => {}),
    now: vi.fn<ReachDueDeps['now']>(() => NOW),
    ...over,
  };
}

const due = (step: number) => ({ householdId: 'hh-1', reachId: REACH_ID, step });

describe('three minutes on, and no answer', () => {
  it('asks the next person, tells her, and sets the three minutes going again', async () => {
    const deps = dueDeps(underWay());
    expect(await handleReachDue(due(1), deps)).toBe('asked_next');

    expect(deps.advance).toHaveBeenCalledWith('hh-1', REACH_ID, 1, [person(sarah), person(david), person(tom)]);
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('David has been asked to ring you as well.');
    // Only the newly asked: Sarah was told already, and Tom is not told yet.
    expect(deps.nudge.mock.calls).toEqual([[['u_david'], PUSH_KINDS.reachRing]]);
    expect(deps.schedule.mock.calls).toEqual([[{ householdId: 'hh-1', reachId: REACH_ID, step: 2, at: NOW + REACH_WAIT_MS }]]);
  });

  it('passes over somebody she has removed since she pressed, and never says they were asked', async () => {
    const deps = dueDeps(underWay(), { listCircle: vi.fn(async () => [tom, sarah]) });
    expect(await handleReachDue(due(1), deps)).toBe('asked_next');
    expect(deps.advance).toHaveBeenCalledWith('hh-1', REACH_ID, 1, [person(sarah), person(tom)]);
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('Tom has been asked to ring you as well.');
    expect(deps.nudge.mock.calls[0]![0]).toEqual(['u_tom']);
  });

  it('says nobody has answered when the last person’s three minutes are over', async () => {
    const deps = dueDeps(underWay({ asked: 3 }));
    expect(await handleReachDue(due(3), deps)).toBe('exhausted');
    expect(deps.finish).toHaveBeenCalledWith('hh-1', REACH_ID, NOW);
    expect(headline(deps.sendCard.mock.calls[0]![0])).toBe('Nobody has answered yet.');
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });

  it('does nothing once somebody has answered', async () => {
    const answered = underWay({ answer: { key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW - 1 } });
    for (const deps of [dueDeps(answered), dueDeps(underWay(), { advance: vi.fn(async () => false) })]) {
      expect(await handleReachDue(due(1), deps)).toBe('settled');
      expect(deps.sendCard).not.toHaveBeenCalled();
      expect(deps.nudge).not.toHaveBeenCalled();
      expect(deps.schedule).not.toHaveBeenCalled();
    }
  });

  it('does nothing for a timer that has been overtaken, a hello, or a request that is not there', async () => {
    for (const deps of [dueDeps(underWay({ asked: 2 })), dueDeps(underWay({ kind: 'hello' })), dueDeps(undefined), dueDeps(underWay({ asked: 3, doneAt: NOW - 1 }))]) {
      expect(await handleReachDue(due(1), deps)).toBe('settled');
      expect(deps.advance).not.toHaveBeenCalled();
      expect(deps.finish).not.toHaveBeenCalled();
    }
  });

  it('ignores anything that is not a timer of its own', async () => {
    for (const detail of [{}, { householdId: 'hh-1', reachId: 'x', step: 1 }, { householdId: 'hh-1', reachId: REACH_ID, step: 0 }, { householdId: 'hh-1', reachId: REACH_ID, step: 1.5 }]) {
      const deps = dueDeps(underWay());
      expect(await handleReachDue(detail, deps)).toBe('ignored');
      expect(deps.load).not.toHaveBeenCalled();
    }
  });
});

describe('the timer', () => {
  const schedule = reachDueSchedule({
    due: { householdId: 'hh_3j5FuSDqN9uRRycIsutK', reachId: REACH_ID, step: 1, at: Date.UTC(2026, 9, 13, 14, 3, 0, 250) },
    targetArn: 'arn:aws:lambda:eu-west-2:1:function:wick-agent-card-action',
    roleArn: 'arn:aws:iam::1:role/wick-reach-timer',
    group: 'wick-reach',
  });

  it('fires once, at that moment, and is gone afterwards', () => {
    expect(schedule).toMatchObject({
      GroupName: 'wick-reach',
      ScheduleExpression: 'at(2026-10-13T14:03:01)',
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
    });
  });

  it('carries only which request and which step — never who', () => {
    expect(schedule.Target).toEqual({
      Arn: 'arn:aws:lambda:eu-west-2:1:function:wick-agent-card-action',
      RoleArn: 'arn:aws:iam::1:role/wick-reach-timer',
      Input: JSON.stringify({ 'detail-type': 'reach.due', detail: { householdId: 'hh_3j5FuSDqN9uRRycIsutK', reachId: REACH_ID, step: 1 } }),
    });
    expect(reachDueEvent({ householdId: 'hh-1', reachId: REACH_ID, step: 2 })).toEqual({ 'detail-type': 'reach.due', detail: { householdId: 'hh-1', reachId: REACH_ID, step: 2 } });
  });

  it('has one name per request and step, in the letters a schedule may have, without the household in it', () => {
    expect(schedule.Name).toMatch(/^[0-9A-Za-z_.-]{1,64}$/);
    expect(schedule.Name).not.toContain('3j5FuSDqN9uRRycIsutK');
    const again = reachDueSchedule({ due: { householdId: 'hh_3j5FuSDqN9uRRycIsutK', reachId: REACH_ID, step: 1, at: NOW }, targetArn: 'a', roleArn: 'r', group: 'g' });
    const other = reachDueSchedule({ due: { householdId: 'hh_other', reachId: REACH_ID, step: 1, at: NOW }, targetArn: 'a', roleArn: 'r', group: 'g' });
    expect(again.Name).toBe(schedule.Name);
    expect(other.Name).not.toBe(schedule.Name);
  });
});

describe('the row', () => {
  const full: ReachRequest = underWay({ asked: 2, answer: { key: 'soon', by: 'u_david', byName: 'David', at: NOW }, doneAt: NOW + 1 });

  it('comes back as it went in', () => {
    expect(reachFromItem(reachItem(underWay()))).toEqual(underWay());
    expect(reachFromItem(reachItem(full))).toEqual(full);
  });

  it('is kept two days, then gone', () => {
    const item = reachItem(underWay());
    expect(item.sk).toEqual({ S: `REACH#${REACH_ID}` });
    expect(Number(item.ttl!.N)).toBe(Math.floor(underWay().askedAt / 1000) + 2 * 86_400);
  });

  it('is not a request when it is anything else', () => {
    for (const item of [{}, { reachId: { S: REACH_ID } }, { ...reachItem(underWay()), order: { S: 'not json' } }, { ...reachItem(underWay()), kind: { S: 'shout' } }]) {
      expect(reachFromItem(item)).toBeUndefined();
    }
  });
});

describe('the store', () => {
  const refused = Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' });

  it('files a request once', async () => {
    const send = vi.fn(async (_command: { input: object }) => ({}));
    expect(await reachStore(send, 'wick').claimOnce(underWay())).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({ TableName: 'wick', ConditionExpression: 'attribute_not_exists(pk)', Item: reachItem(underWay()) });

    expect(await reachStore(vi.fn(async () => { throw refused; }), 'wick').claimOnce(underWay())).toBe(false);
  });

  it('asks the next person only if nobody has answered and no other timer got there first', async () => {
    const send = vi.fn(async (_command: { input: object }) => ({}));
    expect(await reachStore(send, 'wick').advance('hh-1', REACH_ID, 1, [person(sarah), person(tom)])).toBe(true);
    expect(send.mock.calls[0]![0].input).toEqual({
      TableName: 'wick',
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: `REACH#${REACH_ID}` } },
      UpdateExpression: 'SET asked = :next, #order = :order',
      ConditionExpression: 'asked = :from AND attribute_not_exists(answeredAt) AND attribute_not_exists(doneAt)',
      ExpressionAttributeNames: { '#order': 'order' },
      ExpressionAttributeValues: { ':from': { N: '1' }, ':next': { N: '2' }, ':order': { S: JSON.stringify([person(sarah), person(tom)]) } },
    });
    expect(await reachStore(vi.fn(async () => { throw refused; }), 'wick').advance('hh-1', REACH_ID, 1, [])).toBe(false);
  });

  it('keeps the first answer, from somebody who was asked, while it can still be given', async () => {
    const send = vi.fn(async (_command: { input: object }) => ({}));
    const answer = { key: 'now' as const, by: 'u_sarah', byName: 'Sarah', at: NOW };
    expect(await reachStore(send, 'wick').answer('hh-1', REACH_ID, answer)).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      UpdateExpression: 'SET answerKey = :key, answeredAt = :at, answeredBy = :by, answeredByName = :name',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(answeredAt)',
    });
    expect(await reachStore(vi.fn(async () => { throw refused; }), 'wick').answer('hh-1', REACH_ID, answer)).toBe(false);
  });

  it('lets anything but a refusal be heard', async () => {
    const store = reachStore(vi.fn(async () => { throw new Error('throttled'); }), 'wick');
    await expect(store.claimOnce(underWay())).rejects.toThrow('throttled');
    await expect(store.finish('hh-1', REACH_ID, NOW)).rejects.toThrow('throttled');
  });

  it('reads her circle as it stands, with the order she allowed them in', async () => {
    const row = (userId: string, name: string, role: string, status: string, requestedAt: number) => ({ sk: { S: `MEM#${userId}` }, name: { S: name }, role: { S: role }, status: { S: status }, requestedAt: { N: String(requestedAt) } });
    const send = vi.fn(async (_command: { input: object }) => ({ Items: [row('u_sarah', 'Sarah', 'organiser', 'allowed', 10), row('u_dan', 'Dan', 'family', 'pending', 11), row('u_tom', 'Tom', 'neighbour', 'allowed', 5)] }));
    expect(await reachStore(send, 'wick').listCircle('hh-1')).toEqual([
      { userId: 'u_sarah', name: 'Sarah', role: 'organiser', since: 10 },
      { userId: 'u_tom', name: 'Tom', role: 'neighbour', since: 5 },
    ]);
    expect(send.mock.calls[0]![0].input).toMatchObject({ ConsistentRead: true });
  });
});
