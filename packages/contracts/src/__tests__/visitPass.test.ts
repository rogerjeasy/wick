import { describe, expect, it } from 'vitest';
import {
  NOBODY_EXPECTED_NOTICE,
  PUSH_KINDS,
  VISIT_PASS_LIMITS,
  VISITOR_SAYS,
  isPushKind,
  isVisitPassToken,
  isVisitorSays,
  nextLateMinutes,
  passStateAt,
  pushKindForVisitor,
  readVisitSaidDetail,
  readVisitorWord,
  visitPassPk,
  visitorArrivedLine,
  visitorConfirmedNotice,
  visitorDayLine,
  visitorSaidFresh,
} from '../index.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('what a visitor can say from the link', () => {
  it('is three things, and nothing else', () => {
    expect(VISITOR_SAYS).toEqual(['on_way', 'late', 'at_door']);
    expect(isVisitorSays('at_door')).toBe(true);
    expect(isVisitorSays('open_the_door')).toBe(false);
    expect(isVisitorSays(undefined)).toBe(false);
  });

  it('has a nudge of its own for each, a kind and no words', () => {
    expect(pushKindForVisitor('on_way')).toBe(PUSH_KINDS.visitorOnWay);
    expect(pushKindForVisitor('late')).toBe(PUSH_KINDS.visitorLate);
    expect(pushKindForVisitor('at_door')).toBe(PUSH_KINDS.visitorAtDoor);
    for (const kind of ['visitor_on_way', 'visitor_late', 'visitor_at_door']) expect(isPushKind(kind)).toBe(true);
  });
});

describe('the pass token', () => {
  it('is thirty-two lower-case hex characters: one word to any reader, 128 bits', () => {
    expect(isVisitPassToken('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isVisitPassToken('0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(isVisitPassToken('0123456789abcdef')).toBe(false);
    expect(isVisitPassToken('0123456789abcdef0123456789abcdeg')).toBe(false);
    expect(isVisitPassToken(42)).toBe(false);
  });

  it('is found by its hash, never by itself', () => {
    expect(visitPassPk('ab'.repeat(32))).toBe(`VPASS#${'ab'.repeat(32)}`);
  });
});

describe('when a pass works', () => {
  const visit = { at: 10 * HOUR, windowMinutes: 60 };

  it('opens three hours before the visit and closes when its window does', () => {
    expect(passStateAt(visit, 10 * HOUR - 3 * HOUR - 1)).toBe('not_yet');
    expect(passStateAt(visit, 10 * HOUR - 3 * HOUR)).toBe('open');
    expect(passStateAt(visit, 10 * HOUR + 60 * MINUTE)).toBe('open');
    expect(passStateAt(visit, 10 * HOUR + 60 * MINUTE + 1)).toBe('over');
    expect(VISIT_PASS_LIMITS.opensBeforeMs).toBe(3 * HOUR);
  });
});

describe('running late', () => {
  it('adds a quarter of an hour each time, up to the visit window', () => {
    expect(nextLateMinutes(undefined, 60)).toBe(15);
    expect(nextLateMinutes(15, 60)).toBe(30);
    expect(nextLateMinutes(45, 60)).toBe(60);
    expect(nextLateMinutes(60, 60)).toBe(60);
    expect(nextLateMinutes(30, 20)).toBe(20);
  });
});

describe('what the visitor said, as kept on the visit', () => {
  it('is read, not trusted', () => {
    expect(readVisitorWord({ says: 'late', at: 5, lateMinutes: 15 })).toEqual({ says: 'late', at: 5, lateMinutes: 15 });
    expect(readVisitorWord({ says: 'at_door', at: 5 })).toEqual({ says: 'at_door', at: 5 });
    expect(readVisitorWord({ says: 'late', at: 5 })).toBeUndefined();
    expect(readVisitorWord({ says: 'come_in', at: 5 })).toBeUndefined();
    expect(readVisitorWord({ says: 'on_way' })).toBeUndefined();
    expect(readVisitorWord(null)).toBeUndefined();
  });

  it('counts as being at the door for ten minutes either side of the ring', () => {
    const word = { says: 'at_door' as const, at: 100 * MINUTE };
    expect(visitorSaidFresh(word, 100 * MINUTE + 10 * MINUTE)).toBe(true);
    expect(visitorSaidFresh(word, 100 * MINUTE - 10 * MINUTE)).toBe(true);
    expect(visitorSaidFresh(word, 100 * MINUTE + 10 * MINUTE + 1)).toBe(false);
    expect(visitorSaidFresh({ says: 'on_way', at: 100 * MINUTE }, 100 * MINUTE)).toBe(false);
    expect(visitorSaidFresh(undefined, 0)).toBe(false);
  });
});

describe('the event on the bus', () => {
  it('carries ids, what was said and when — never a name or a token', () => {
    const detail = { householdId: 'hh-1', errandId: 'err_abcdefghijklmnopqrst', says: 'at_door', at: 9 };
    expect(readVisitSaidDetail(detail)).toEqual(detail);
    expect(readVisitSaidDetail({ ...detail, says: 'hello' })).toBeUndefined();
    expect(readVisitSaidDetail({ ...detail, errandId: 'nope' })).toBeUndefined();
    expect(readVisitSaidDetail({ ...detail, householdId: '' })).toBeUndefined();
    expect(readVisitSaidDetail({ ...detail, at: 'now' })).toBeUndefined();
  });
});

describe('Wick’s sentences', () => {
  it('says the visitor is at the door, in the family’s words for them', () => {
    expect(visitorArrivedLine('the doctor')).toBe('The doctor is at your door.');
    expect(visitorArrivedLine('Doctor Rossi')).toBe('Doctor Rossi is at your door.');
  });

  it('says how Wick knows, and who arranged it, by first name', () => {
    expect(visitorConfirmedNotice('Sarah Jones')).toBe('They confirmed it on their phone just now. Sarah arranged this visit.');
  });

  it('says nobody is expected, and leaves the door hers', () => {
    expect(NOBODY_EXPECTED_NOTICE).toBe('Nobody is expected at the door now. You don’t have to open.');
    expect(NOBODY_EXPECTED_NOTICE).not.toMatch(/\bcan open\b|\bopen it\b|\blet .* in\b/i);
  });

  it('puts what the visitor said on her day', () => {
    expect(visitorDayLine('Doctor Rossi', { says: 'on_way', at: 1 }, 'Sarah')).toBe('Doctor Rossi is on the way. Sarah arranged it.');
    expect(visitorDayLine('the doctor', { says: 'late', at: 1, lateMinutes: 15 }, 'Sarah')).toBe('The doctor will be about 15 minutes late.');
    expect(visitorDayLine('Doctor Rossi', { says: 'at_door', at: 1 }, 'Sarah')).toBe('Doctor Rossi says they are at your door. Sarah arranged it.');
    expect(visitorDayLine('Doctor Rossi', { says: 'on_way', at: 1 }, undefined)).toBe('Doctor Rossi is on the way.');
  });
});
