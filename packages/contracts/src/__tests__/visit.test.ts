import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_ACTIONS,
  VISIT_ACTIONS,
  VISIT_ASK_WITHIN_MS,
  VISIT_MIN_MS,
  VISIT_SETTLED_MS,
  VISIT_WINDOW_MS,
  buildVisitCard,
  departureOf,
  disputedSentence,
  parseVisitId,
  readyToAsk,
  visitAnswerOf,
  visitCardId,
  visitId,
  visitIdFromCardId,
  visitSentence,
  visitSk,
  type Visit,
} from '../index.js';

const LONDON = 'Europe/London';
const MIN = 60_000;
/** Tuesday 13 October 2026, 9:02 in London (BST). */
const ARRIVED = Date.UTC(2026, 9, 13, 8, 2);
const LEFT = ARRIVED + 45 * MIN;

const visit = (over: Partial<Visit> = {}): Visit => ({ householdId: 'hh-1', personId: 'maria', name: 'Maria', arrivedAt: ARRIVED, ...over });

describe('a visit’s name', () => {
  it('is when the visitor came and who they are, and the card and the row share it', () => {
    expect(visitId(visit())).toBe(`${ARRIVED}-maria`);
    expect(visitSk(visit())).toBe(`VISIT#${String(ARRIVED).padStart(15, '0')}#maria`);
    expect(visitCardId(visitId(visit()))).toBe(`visit-${ARRIVED}-maria`);
    expect(visitIdFromCardId(`visit-${ARRIVED}-maria`)).toBe(`${ARRIVED}-maria`);
    expect(parseVisitId(`${ARRIVED}-member-u_1`)).toEqual({ arrivedAt: ARRIVED, personId: 'member-u_1' });
  });

  it('is not read out of any other card, or out of anything that could not be a key', () => {
    for (const id of ['reach-1790000000000', 'visit-', 'visit-abc-maria', `visit-${ARRIVED}-`, `visit-${ARRIVED}-ma#ria`, `visit-${ARRIVED}-ma ria`]) {
      expect(visitIdFromCardId(id)).toBeUndefined();
    }
    expect(parseVisitId('nonsense')).toBeUndefined();
  });
});

describe('what a press means', () => {
  it('is that it is right, or that it is not', () => {
    expect(visitAnswerOf(VISIT_ACTIONS.right)).toBe('confirmed');
    expect(visitAnswerOf(VISIT_ACTIONS.wrong)).toBe('disputed');
    expect(visitAnswerOf('tell_family')).toBeUndefined();
  });
});

describe('when a visitor is taken to have left', () => {
  it('is when the door next sees somebody, once they have been in long enough to have visited', () => {
    expect(departureOf(visit(), ARRIVED + VISIT_MIN_MS)).toBe(true);
    expect(departureOf(visit(), LEFT)).toBe(true);
  });

  it('is not the visitor still on the step, nor somebody at the door hours later, nor anything before they came', () => {
    expect(departureOf(visit(), ARRIVED + VISIT_MIN_MS - 1)).toBe(false);
    expect(departureOf(visit(), ARRIVED + VISIT_WINDOW_MS + 1)).toBe(false);
    expect(departureOf(visit(), ARRIVED - 1)).toBe(false);
  });

  it('can be put later by a later sighting — the last one before she is asked is the one', () => {
    expect(departureOf(visit({ leftAt: ARRIVED + 20 * MIN }), LEFT)).toBe(true);
    expect(departureOf(visit({ leftAt: LEFT }), ARRIVED + 20 * MIN)).toBe(false);
  });

  it('is settled once she has been asked', () => {
    expect(departureOf(visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS }), LEFT + 30 * MIN)).toBe(false);
  });
});

describe('when she is asked', () => {
  it('is once the visitor has been gone a little while — not the moment the door moves', () => {
    expect(readyToAsk(visit({ leftAt: LEFT }), LEFT + VISIT_SETTLED_MS - 1)).toBe(false);
    expect(readyToAsk(visit({ leftAt: LEFT }), LEFT + VISIT_SETTLED_MS)).toBe(true);
  });

  it('is about the arrival alone when nobody was seen leaving', () => {
    expect(readyToAsk(visit(), ARRIVED + VISIT_WINDOW_MS - 1)).toBe(false);
    expect(readyToAsk(visit(), ARRIVED + VISIT_WINDOW_MS)).toBe(true);
  });

  it('is once, and never about a visit from long ago', () => {
    expect(readyToAsk(visit({ leftAt: LEFT, askedAt: LEFT + VISIT_SETTLED_MS }), LEFT + 60 * MIN)).toBe(false);
    expect(readyToAsk(visit({ leftAt: LEFT }), ARRIVED + VISIT_ASK_WITHIN_MS)).toBe(false);
  });
});

describe('the words', () => {
  it('say who, the day by name and the times where the house is — still true when read another day', () => {
    expect(visitSentence(visit({ leftAt: LEFT }), LONDON)).toBe('Maria was here on Tuesday from 9:02 am to 9:47 am.');
    expect(visitSentence(visit(), LONDON)).toBe('Maria came on Tuesday at 9:02 am.');
  });

  it('say an afternoon as an afternoon', () => {
    expect(visitSentence(visit({ arrivedAt: ARRIVED + 5 * 60 * MIN, leftAt: LEFT + 5 * 60 * MIN }), LONDON)).toBe('Maria was here on Tuesday from 2:02 pm to 2:47 pm.');
  });

  it('say what the family would be told when she says it is not right', () => {
    expect(disputedSentence(visit({ leftAt: LEFT }), LONDON)).toBe('Wick noted that Maria was here on Tuesday from 9:02 am to 9:47 am. That is not right.');
  });
});

describe('the card', () => {
  const queued = buildVisitCard(visit({ leftAt: LEFT }), LONDON, LEFT + VISIT_SETTLED_MS);

  it('shows her what was noted and asks whether it is right', () => {
    expect(queued.id).toBe(`visit-${ARRIVED}-maria`);
    expect(queued.card).toMatchObject({ type: 'VISIT', headline: 'Is this right?', detail: 'Maria was here on Tuesday from 9:02 am to 9:47 am.' });
  });

  it('offers yes and no, and nothing else', () => {
    expect(queued.card.actions).toEqual([
      { id: VISIT_ACTIONS.right, label: 'Yes, that’s right', kind: 'primary' },
      { id: VISIT_ACTIONS.wrong, label: 'No, that’s not right', kind: 'secondary' },
    ]);
    expect(queued.card.actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
  });

  it('waits for a natural break, like a note: nothing about a visit that is over is urgent', () => {
    expect(queued.urgency).toBe('DEFERRED');
    expect(queued.expiresAt).toBeUndefined();
  });
});
