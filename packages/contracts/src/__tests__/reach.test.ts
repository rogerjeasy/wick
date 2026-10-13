import { describe, expect, it } from 'vitest';
import {
  MAX_CARD_ACTIONS,
  MAX_CARD_DETAIL_CHARS,
  REACH_ACTIONS,
  REACH_ANSWERS,
  REACH_UNDER_WAY_MS,
  REACH_WAIT_MS,
  answersFor,
  buildReachAskCard,
  buildReachCard,
  isReachAnswer,
  reachAsked,
  reachCardId,
  reachIdFromCardId,
  reachKindOf,
  reachOrder,
  reachUnderWay,
  wasAsked,
  type ReachPerson,
  type ReachRequest,
} from '../index.js';

const NOW = Date.UTC(2026, 9, 13, 14, 0);
const REACH_ID = String(NOW);

const sarah: ReachPerson = { userId: 'u_sarah', name: 'Sarah Hughes', role: 'organiser' };
const david: ReachPerson = { userId: 'u_david', name: 'David', role: 'family' };
const tom: ReachPerson = { userId: 'u_tom', name: 'Tom Next-Door', role: 'neighbour' };

const request = (over: Partial<ReachRequest> = {}): ReachRequest => ({
  householdId: 'hh-1',
  reachId: REACH_ID,
  kind: 'ring',
  askedAt: NOW,
  order: [sarah, david, tom],
  asked: 1,
  ...over,
});

describe('the card’s id', () => {
  it('names the request, and only a request', () => {
    expect(reachCardId(REACH_ID)).toBe(`reach-${REACH_ID}`);
    expect(reachIdFromCardId(`reach-${REACH_ID}`)).toBe(REACH_ID);
  });

  it('is not read out of any other card, nor out of anything but a moment', () => {
    for (const id of ['light', 'reach-', 'reach-abc', 'reach-12', 'reach-1790000000000#x', `tell-${REACH_ID}`, 'reach-1790000000000-extra']) {
      expect(reachIdFromCardId(id)).toBeUndefined();
    }
  });
});

describe('what a press means', () => {
  it('is to be rung, or to say hello', () => {
    expect(reachKindOf(REACH_ACTIONS.ring)).toBe('ring');
    expect(reachKindOf(REACH_ACTIONS.hello)).toBe('hello');
  });

  it('is nothing for the way out, or for any other button', () => {
    for (const action of [REACH_ACTIONS.notNow, REACH_ACTIONS.ok, 'tell_family', undefined, 7]) expect(reachKindOf(action)).toBeUndefined();
  });
});

describe('who is asked, and in what order', () => {
  it('asks the organiser first, then the family in the order she allowed them, and a neighbour last', () => {
    const order = reachOrder([
      { ...tom, since: 1 },
      { ...david, since: 30 },
      { userId: 'u_anna', name: 'Anna', role: 'family', since: 20 },
      { ...sarah, since: 40 },
    ]);
    expect(order.map((p) => p.userId)).toEqual(['u_sarah', 'u_anna', 'u_david', 'u_tom']);
  });

  it('keeps only who, as whom and in what part — never when', () => {
    expect(reachOrder([{ ...sarah, since: 40 }])).toEqual([sarah]);
  });

  it('is settled between two people allowed at the same moment', () => {
    const a = { userId: 'u_a', name: 'A', role: 'family' as const, since: 5 };
    const b = { userId: 'u_b', name: 'B', role: 'family' as const, since: 5 };
    expect(reachOrder([b, a]).map((p) => p.userId)).toEqual(reachOrder([a, b]).map((p) => p.userId));
  });
});

describe('who a request has reached', () => {
  it('is only the people asked so far', () => {
    expect(reachAsked(request({ asked: 2 }))).toEqual([sarah, david]);
    expect(wasAsked(request({ asked: 2 }), 'u_david')).toBe(true);
    expect(wasAsked(request({ asked: 2 }), 'u_tom')).toBe(false);
  });

  it('is nobody who was never in the circle', () => {
    expect(wasAsked(request({ asked: 3 }), 'u_stranger')).toBe(false);
  });
});

describe('whether a request is still under way', () => {
  it('is, while somebody may yet be asked or answer', () => {
    expect(reachUnderWay(request(), NOW + REACH_WAIT_MS)).toBe(true);
  });

  it('is not once it is answered, once everyone has been asked in vain, or long after', () => {
    expect(reachUnderWay(request({ answer: { key: 'now', by: 'u_sarah', byName: 'Sarah', at: NOW + 1 } }), NOW + 2)).toBe(false);
    expect(reachUnderWay(request({ asked: 3, doneAt: NOW + 3 * REACH_WAIT_MS }), NOW + 3 * REACH_WAIT_MS + 1)).toBe(false);
    expect(reachUnderWay(request(), NOW + REACH_UNDER_WAY_MS)).toBe(false);
  });
});

describe('a hello', () => {
  it('is never under way: nobody else will be asked, so holding the button again offers a new request at once', () => {
    expect(reachUnderWay(request({ kind: 'hello', order: [sarah] }), NOW + 1)).toBe(false);
  });
});

describe('the answers', () => {
  it('are chosen, never written: two to a request to ring, one to a hello', () => {
    expect(answersFor('ring')).toEqual(['now', 'soon']);
    expect(answersFor('hello')).toEqual(['hello']);
    expect(isReachAnswer('now')).toBe(true);
    expect(isReachAnswer('I will ring when I can')).toBe(false);
  });

  it('never tell her that anyone is coming, and never promise more than a call', () => {
    for (const text of Object.values(REACH_ANSWERS)) expect(text).not.toMatch(/coming|on my way|ambulance|doctor|help/i);
  });
});

describe('the card that asks her', () => {
  const ask = buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, first: sarah, now: NOW });

  it('names the one person who would be asked first, by the first name she knows them by', () => {
    expect(ask.id).toBe(`reach-${REACH_ID}`);
    expect(ask.card).toMatchObject({ type: 'REACH', headline: 'Ask Sarah to ring you?' });
  });

  it('offers to be rung, to say hello, and a way out — and nothing else', () => {
    expect(ask.card.actions.map((a) => a.id)).toEqual([REACH_ACTIONS.ring, REACH_ACTIONS.hello, REACH_ACTIONS.notNow]);
    expect(ask.card.actions.length).toBeLessThanOrEqual(MAX_CARD_ACTIONS);
    expect(ask.card.actions.at(-1)).toMatchObject({ kind: 'dismiss' });
  });

  it('says what will be told, and that it is not an emergency service', () => {
    const detail = ask.card.type === 'REACH' ? ask.card.detail : '';
    expect(detail).toMatch(/Sarah will be told only that you would like a call/);
    expect(detail).toMatch(/does not call for help/);
  });

  it('waits for a break like any other card: only her own hold brings it forward', () => {
    expect(ask.urgency).toBe('DEFERRED');
    expect(ask.expiresAt).toBeUndefined();
  });

  it('says so plainly when there is nobody to ask, and offers nothing that would reach nobody', () => {
    const nobody = buildReachAskCard({ householdId: 'hh-1', reachId: REACH_ID, now: NOW });
    expect(nobody.card).toMatchObject({ type: 'REACH', headline: 'There is nobody Wick can ask just now.' });
    expect(nobody.card.actions.map((a) => a.id)).toEqual([REACH_ACTIONS.ok]);
  });
});

describe('the card that says where her request stands', () => {
  const words = (r: ReachRequest) => {
    const { card } = buildReachCard(r, NOW);
    if (card.type !== 'REACH') throw new Error('not a reach card');
    return { headline: card.headline, detail: card.detail, actions: card.actions.map((a) => a.label) };
  };

  it('keeps the id of the card she pressed, so it is replaced in place', () => {
    expect(buildReachCard(request(), NOW).id).toBe(`reach-${REACH_ID}`);
  });

  it('says who was asked, and who is next if they do not answer', () => {
    expect(words(request())).toEqual({
      headline: 'Sarah has been asked to ring you.',
      detail: 'If Sarah has not answered in three minutes, Wick will ask David.',
      actions: ['All right'],
    });
  });

  it('says when the next person has been asked as well', () => {
    expect(words(request({ asked: 2 }))).toEqual({
      headline: 'David has been asked to ring you as well.',
      detail: 'Sarah has not answered yet. If nobody has answered in three minutes, Wick will ask Tom.',
      actions: ['All right'],
    });
  });

  it('promises nobody further when the last person has been asked', () => {
    expect(words(request({ asked: 3 })).detail).toBe('Sarah and David have not answered yet. Wick will tell you here when somebody answers.');
    expect(words(request({ order: [sarah], asked: 1 })).detail).toBe('Wick will tell you here when Sarah answers.');
  });

  it('says so when everyone has been asked and nobody has answered', () => {
    expect(words(request({ asked: 3, doneAt: NOW + 9 * 60_000 }))).toEqual({
      headline: 'Nobody has answered yet.',
      detail: 'Sarah, David and Tom have been asked, and can still answer. Wick will tell you here if one of them does.',
      actions: ['All right'],
    });
  });

  it('gives the answer under the name of the person who gave it', () => {
    expect(words(request({ asked: 2, answer: { key: 'now', by: 'u_david', byName: 'David', at: NOW + 1 } }))).toEqual({
      headline: 'David says: I’m ringing you now.',
      detail: undefined,
      actions: ['Thank you'],
    });
  });

  it('says a hello was passed on, and gives the hello that comes back', () => {
    expect(words(request({ kind: 'hello', order: [sarah] }))).toEqual({ headline: 'Sarah has been told you said hello.', detail: undefined, actions: ['All right'] });
    expect(words(request({ kind: 'hello', order: [sarah], answer: { key: 'hello', by: 'u_sarah', byName: 'Sarah', at: NOW + 1 } })).headline).toBe('Sarah says: Hello to you too.');
  });

  it('never runs past what a card can show, however many are in the circle', () => {
    const many = Array.from({ length: 12 }, (_, i): ReachPerson => ({ userId: `u_${i}`, name: `Bartholomew${i} Featherstonehaugh`, role: 'family' }));
    for (const asked of [1, 6, 12]) {
      for (const doneAt of [undefined, NOW + 1]) {
        const { detail } = words(request({ order: many, asked, ...(doneAt === undefined ? {} : { doneAt }) }));
        expect((detail ?? '').length).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
      }
    }
  });
});
