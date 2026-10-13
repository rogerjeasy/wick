import { describe, expect, it, vi, type Mock } from 'vitest';
import { VISIT_ACTIONS, VISIT_SETTLED_MS, VISIT_WINDOW_MS, visitCardId, visitId, type Visit, type VisitorMatch } from '@wick/contracts';
import { noteDoorSighting, type NoteDeps } from '../note.js';
import { askAboutVisits, type AskVisitDeps } from '../ask.js';
import { handleVisitAnswer, type VisitAnswerDeps } from '../answer.js';
import { visitFromItem, visitItem, visitStore } from '../../../store/visits.js';

const LONDON = 'Europe/London';
const MIN = 60_000;
/** Tuesday 13 October 2026, 9:02 in London. */
const ARRIVED = Date.UTC(2026, 9, 13, 8, 2);
const LEFT = ARRIVED + 45 * MIN;

const maria: VisitorMatch = { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 1 };
const visit = (over: Partial<Visit> = {}): Visit => ({ householdId: 'hh-1', personId: 'maria', name: 'Maria', arrivedAt: ARRIVED, ...over });

type Spies<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : T[K] };

function noteDeps(recent: Visit[] = [], over: Partial<Spies<NoteDeps>> = {}): Spies<NoteDeps> {
  return {
    recent: vi.fn<NoteDeps['recent']>(async () => recent),
    open: vi.fn<NoteDeps['open']>(async () => true),
    setLeft: vi.fn<NoteDeps['setLeft']>(async () => true),
    ...over,
  };
}

describe('the door sees somebody', () => {
  it('opens a visit when it is a regular visitor arriving', async () => {
    const deps = noteDeps();
    expect(await noteDoorSighting({ householdId: 'hh-1', match: maria, at: ARRIVED }, deps)).toBe('arrived');
    expect(deps.open).toHaveBeenCalledWith(visit());
    expect(deps.setLeft).not.toHaveBeenCalled();
    // Only as far back as a visit can last.
    expect(deps.recent).toHaveBeenCalledWith('hh-1', ARRIVED - VISIT_WINDOW_MS);
  });

  it('takes a later sighting as the visitor leaving, whoever it looks like', async () => {
    for (const match of [undefined, maria]) {
      const deps = noteDeps([visit()]);
      expect(await noteDoorSighting({ householdId: 'hh-1', match, at: LEFT }, deps)).toBe('left');
      expect(deps.setLeft).toHaveBeenCalledWith(visit(), LEFT);
      expect(deps.open).not.toHaveBeenCalled();
    }
  });

  it('does not take the visitor still on the step for the visitor leaving, nor open a second visit', async () => {
    const deps = noteDeps([visit()]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: maria, at: ARRIVED + MIN }, deps)).toBe('nothing');
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.setLeft).not.toHaveBeenCalled();
  });

  it('opens a visit for a second regular visitor who arrives while the first is still inside — and does not take that for the first one leaving', async () => {
    const cleaner: VisitorMatch = { ...maria, personId: 'ana', name: 'Ana' };
    const deps = noteDeps([visit()]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: cleaner, at: ARRIVED + 20 * MIN }, deps)).toBe('arrived');
    expect(deps.open).toHaveBeenCalledWith({ householdId: 'hh-1', personId: 'ana', name: 'Ana', arrivedAt: ARRIVED + 20 * MIN });
    expect(deps.setLeft).not.toHaveBeenCalled();
  });

  it('takes the next sighting after that as both of them leaving: the door cannot tell which, and she is asked about each', async () => {
    const ana = visit({ personId: 'ana', name: 'Ana', arrivedAt: ARRIVED + 20 * MIN });
    const deps = noteDeps([visit(), ana]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: undefined, at: LEFT }, deps)).toBe('left');
    expect(deps.setLeft.mock.calls.map(([v]) => v.personId)).toEqual(['maria', 'ana']);
  });

  it('still takes a visitor seen again as that visitor leaving, when it is the one whose visit is under way', async () => {
    const deps = noteDeps([visit()]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: maria, at: ARRIVED + 20 * MIN }, deps)).toBe('left');
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('opens nothing for a stranger, and nothing for one of the family who said they were coming', async () => {
    for (const match of [undefined, { ...maria, personId: 'member-u_sarah', name: 'Sarah' }]) {
      const deps = noteDeps();
      expect(await noteDoorSighting({ householdId: 'hh-1', match, at: ARRIVED }, deps)).toBe('nothing');
      expect(deps.open).not.toHaveBeenCalled();
    }
  });

  it('opens nothing for a visitor whose id could not name a row or a card', async () => {
    const deps = noteDeps();
    expect(await noteDoorSighting({ householdId: 'hh-1', match: { ...maria, personId: 'ma#ria 1' }, at: ARRIVED }, deps)).toBe('nothing');
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('opens a new visit when the same visitor comes again later in the day', async () => {
    const morning = visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS, answer: 'confirmed' });
    const evening = ARRIVED + 3 * 60 * MIN;
    const deps = noteDeps([morning]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: maria, at: evening }, deps)).toBe('arrived');
    expect(deps.open).toHaveBeenCalledWith(visit({ arrivedAt: evening }));
  });

  it('leaves alone a visit she has already been asked about', async () => {
    const deps = noteDeps([visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS })]);
    expect(await noteDoorSighting({ householdId: 'hh-1', match: undefined, at: LEFT + 30 * MIN }, deps)).toBe('nothing');
    expect(deps.setLeft).not.toHaveBeenCalled();
  });
});

function askDeps(recent: Visit[], over: Partial<Spies<AskVisitDeps>> = {}): Spies<AskVisitDeps> {
  return {
    recent: vi.fn<AskVisitDeps['recent']>(async () => recent),
    claimAsk: vi.fn<AskVisitDeps['claimAsk']>(async () => true),
    releaseAsk: vi.fn<AskVisitDeps['releaseAsk']>(async () => {}),
    sendCard: vi.fn<AskVisitDeps['sendCard']>(async () => {}),
    now: vi.fn<AskVisitDeps['now']>(() => LEFT + VISIT_SETTLED_MS),
    timeZone: LONDON,
    ...over,
  };
}

describe('asking her', () => {
  it('puts what was noted to her once the visitor has been gone a little while', async () => {
    const deps = askDeps([visit({ leftAt: LEFT })]);
    expect(await askAboutVisits('hh-1', deps)).toEqual([visitId(visit())]);
    expect(deps.claimAsk).toHaveBeenCalledWith(visit({ leftAt: LEFT }), LEFT + VISIT_SETTLED_MS);
    const card = deps.sendCard.mock.calls[0]![0];
    expect(card.id).toBe(visitCardId(visitId(visit())));
    expect(card.card).toMatchObject({ type: 'VISIT', detail: 'Maria was here on Tuesday from 9:02 am to 9:47 am.' });
  });

  it('asks nothing about a visit that is not settled, was asked about already, or is a demo home’s history', async () => {
    const deps = askDeps([visit({ leftAt: LEFT + 5 * MIN }), visit({ arrivedAt: ARRIVED - 60 * MIN, leftAt: ARRIVED - 30 * MIN, askedAt: ARRIVED }), visit({ arrivedAt: ARRIVED - 120 * MIN, leftAt: ARRIVED - 90 * MIN, simulated: true, answer: 'confirmed', askedAt: ARRIVED })]);
    expect(await askAboutVisits('hh-1', deps)).toEqual([]);
    expect(deps.sendCard).not.toHaveBeenCalled();
  });

  it('asks once: a question another television’s signal already put is not put again', async () => {
    const deps = askDeps([visit({ leftAt: LEFT })], { claimAsk: vi.fn<AskVisitDeps['claimAsk']>(async () => false) });
    expect(await askAboutVisits('hh-1', deps)).toEqual([]);
    expect(deps.sendCard).not.toHaveBeenCalled();
  });

  it('takes the asking back when the card could not be sent, so she is asked next time rather than never', async () => {
    const deps = askDeps([visit({ leftAt: LEFT })], { sendCard: vi.fn<AskVisitDeps['sendCard']>(async () => { throw new Error('down'); }) });
    expect(await askAboutVisits('hh-1', deps)).toEqual([]);
    expect(deps.releaseAsk).toHaveBeenCalledWith(visit({ leftAt: LEFT }));
  });
});

const press = (action: string, cardId = visitCardId(visitId(visit()))) => ({ householdId: 'hh-1', deviceId: 'tv-1', cardId, action, at: LEFT + 20 * MIN });
const NOW = LEFT + 20 * MIN;

function answerDeps(answered: Visit | undefined, over: Partial<Spies<VisitAnswerDeps>> = {}): Spies<VisitAnswerDeps> {
  return {
    answer: vi.fn<VisitAnswerDeps['answer']>(async () => answered),
    withdraw: vi.fn<VisitAnswerDeps['withdraw']>(async () => {}),
    whoToTell: vi.fn<VisitAnswerDeps['whoToTell']>(async () => 'Sarah'),
    offerToTell: vi.fn<VisitAnswerDeps['offerToTell']>(async () => true),
    now: vi.fn<VisitAnswerDeps['now']>(() => NOW),
    timeZone: LONDON,
    ...over,
  };
}

describe('her answer', () => {
  const asked = visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS });

  it('"Yes, that’s right" makes it a visit she confirmed, and tells nobody anything', async () => {
    const deps = answerDeps({ ...asked, answer: 'confirmed', answeredAt: NOW });
    expect(await handleVisitAnswer(press(VISIT_ACTIONS.right), deps)).toBe('confirmed');
    expect(deps.answer).toHaveBeenCalledWith('hh-1', visitId(visit()), 'confirmed', NOW);
    expect(deps.withdraw).toHaveBeenCalledWith('hh-1', visitCardId(visitId(visit())));
    expect(deps.offerToTell).not.toHaveBeenCalled();
  });

  it('"No, that’s not right" confirms nothing, and asks her whether the family should hear — showing the very sentence', async () => {
    const deps = answerDeps({ ...asked, answer: 'disputed', answeredAt: NOW });
    expect(await handleVisitAnswer(press(VISIT_ACTIONS.wrong), deps)).toBe('disputed');
    expect(deps.offerToTell).toHaveBeenCalledWith({
      householdId: 'hh-1',
      differenceId: `visit_disputed-${visitId(visit())}`,
      sentence: 'Wick noted that Maria was here on Tuesday from 9:02 am to 9:47 am. That is not right.',
      who: 'Sarah',
      at: ARRIVED,
      now: NOW,
    });
  });

  it('offers to tell nobody when there is nobody she shares her visitors with', async () => {
    const deps = answerDeps({ ...asked, answer: 'disputed', answeredAt: NOW }, { whoToTell: vi.fn<VisitAnswerDeps['whoToTell']>(async () => undefined) });
    expect(await handleVisitAnswer(press(VISIT_ACTIONS.wrong), deps)).toBe('disputed');
    expect(deps.offerToTell).not.toHaveBeenCalled();
  });

  it('takes the first answer: a second press, or one for a visit that is not open, changes nothing', async () => {
    const deps = answerDeps(undefined);
    expect(await handleVisitAnswer(press(VISIT_ACTIONS.wrong), deps)).toBe('not_open');
    expect(deps.withdraw).not.toHaveBeenCalled();
    expect(deps.offerToTell).not.toHaveBeenCalled();
  });

  it('still stands when the card could not be withdrawn or the question could not be put', async () => {
    const deps = answerDeps({ ...asked, answer: 'disputed', answeredAt: NOW }, {
      withdraw: vi.fn<VisitAnswerDeps['withdraw']>(async () => { throw new Error('down'); }),
      offerToTell: vi.fn<VisitAnswerDeps['offerToTell']>(async () => { throw new Error('down'); }),
    });
    expect(await handleVisitAnswer(press(VISIT_ACTIONS.wrong), deps)).toBe('disputed');
  });

  it('ignores a press that is not an answer to a visit', async () => {
    for (const detail of [press('tell_family'), press(VISIT_ACTIONS.right, 'reach-1790000000000'), { ...press(VISIT_ACTIONS.right), householdId: '' }]) {
      const deps = answerDeps(undefined);
      expect(await handleVisitAnswer(detail, deps)).toBe('ignored');
      expect(deps.answer).not.toHaveBeenCalled();
    }
  });
});

describe('the row', () => {
  const full = visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS, answer: 'confirmed', answeredAt: NOW, simulated: true });

  it('comes back as it went in', () => {
    expect(visitFromItem(visitItem(visit()))).toEqual(visit());
    expect(visitFromItem(visitItem(full))).toEqual(full);
  });

  it('is kept for thirteen months: it is a record, and a year of them is what a record is for', () => {
    const item = visitItem(visit());
    expect(item.sk).toEqual({ S: `VISIT#${String(ARRIVED).padStart(15, '0')}#maria` });
    expect(Number(item.ttl!.N)).toBe(Math.floor(ARRIVED / 1000) + 400 * 86_400);
  });

  it('is not a visit when it is anything else', () => {
    for (const item of [{}, { pk: { S: 'HH#hh-1' }, personId: { S: 'maria' } }, { ...visitItem(visit()), answer: { S: 'maybe' } }]) {
      expect(visitFromItem(item)?.answer).toBeUndefined();
    }
    expect(visitFromItem({})).toBeUndefined();
  });
});

describe('the store', () => {
  const refused = Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' });
  const sent = () => vi.fn(async (_command: { input: object }) => ({}));

  it('opens a visit once', async () => {
    const send = sent();
    expect(await visitStore(send, 'wick').open(visit())).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({ Item: visitItem(visit()), ConditionExpression: 'attribute_not_exists(pk)' });
    expect(await visitStore(vi.fn(async () => { throw refused; }), 'wick').open(visit())).toBe(false);
  });

  it('moves the leaving later only, and never once she has been asked', async () => {
    const send = sent();
    expect(await visitStore(send, 'wick').setLeft(visit(), LEFT)).toBe(true);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      UpdateExpression: 'SET leftAt = :at',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(askedAt) AND (attribute_not_exists(leftAt) OR leftAt < :at)',
    });
  });

  it('asks once, and can take the asking back only while it is unanswered', async () => {
    const send = sent();
    const store = visitStore(send, 'wick');
    expect(await store.claimAsk(visit({ leftAt: LEFT }), NOW)).toBe(true);
    await store.releaseAsk(visit({ leftAt: LEFT }));
    expect(send.mock.calls[0]![0].input).toMatchObject({ UpdateExpression: 'SET askedAt = :at', ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(askedAt)' });
    expect(send.mock.calls[1]![0].input).toMatchObject({ UpdateExpression: 'REMOVE askedAt', ConditionExpression: 'attribute_not_exists(answer)' });
  });

  it('keeps the first answer and hands back the visit as it then stands', async () => {
    const send = vi.fn(async (_command: { input: object }) => ({ Attributes: visitItem(visit({ leftAt: LEFT, askedAt: NOW - 1, answer: 'disputed', answeredAt: NOW })) }));
    expect(await visitStore(send, 'wick').answer('hh-1', visitId(visit()), 'disputed', NOW)).toMatchObject({ answer: 'disputed', leftAt: LEFT });
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Key: { pk: { S: 'HH#hh-1' }, sk: { S: `VISIT#${String(ARRIVED).padStart(15, '0')}#maria` } },
      ConditionExpression: 'attribute_exists(askedAt) AND attribute_not_exists(answer)',
      ReturnValues: 'ALL_NEW',
    });
    expect(await visitStore(vi.fn(async () => { throw refused; }), 'wick').answer('hh-1', visitId(visit()), 'disputed', NOW)).toBeUndefined();
    expect(await visitStore(sent(), 'wick').answer('hh-1', 'nonsense', 'disputed', NOW)).toBeUndefined();
  });

  it('reads a stretch of visits in the order they happened', async () => {
    const send = vi.fn(async (_command: { input: object }) => ({ Items: [visitItem(visit()), { pk: { S: 'HH#hh-1' } }] }));
    expect(await visitStore(send, 'wick').recent('hh-1', ARRIVED - 1)).toEqual([visit()]);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': { S: 'HH#hh-1' }, ':from': { S: `VISIT#${String(ARRIVED - 1).padStart(15, '0')}` }, ':to': { S: 'VISIT#999999999999999#￿' } },
      ConsistentRead: true,
    });
  });
});
