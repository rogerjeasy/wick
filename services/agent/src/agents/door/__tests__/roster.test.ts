import { describe, it, expect } from 'vitest';
import type { RosterEntry } from '@wick/contracts';
import { matchVisitor, stillWelcome } from '../roster.js';

const maria: RosterEntry = {
  personId: 'maria',
  name: 'Maria',
  expectedPattern: 'TUE,FRI 09:00±30m',
};

// Tuesday 2026-09-15 (verified: getUTCDay() === 2 for this date).
const tuesdayAt = (hh: number, mm: number): number => Date.UTC(2026, 8, 15, hh, mm);
// Monday 2026-09-14.
const mondayAt = (hh: number, mm: number): number => Date.UTC(2026, 8, 14, hh, mm);

describe('matchVisitor', () => {
  it('matches a roster entry inside its expected day and time window', () => {
    const match = matchVisitor([maria], tuesdayAt(9, 10));
    expect(match).toMatchObject({ personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true });
  });

  it('matches at the exact edge of the window', () => {
    expect(matchVisitor([maria], tuesdayAt(9, 30))).toBeDefined(); // +30m, inclusive
    expect(matchVisitor([maria], tuesdayAt(8, 30))).toBeDefined(); // -30m, inclusive
  });

  it('does not match just outside the window, even on an expected day', () => {
    expect(matchVisitor([maria], tuesdayAt(9, 31))).toBeUndefined();
    expect(matchVisitor([maria], tuesdayAt(8, 29))).toBeUndefined();
  });

  it('does not match on a day the person is not expected, even at the right time', () => {
    expect(matchVisitor([maria], mondayAt(9, 10))).toBeUndefined();
  });

  it('never claims roster_face — Ring gives no facial recognition, and D3 is explicit: schedule only', () => {
    expect(matchVisitor([maria], tuesdayAt(9, 10))?.basis).toBe('schedule');
  });

  it('returns undefined for a roster with no expectedPattern at all — never guess from nothing', () => {
    const gardener: RosterEntry = { personId: 'gardener', name: 'Sam' };
    expect(matchVisitor([gardener], tuesdayAt(9, 10))).toBeUndefined();
  });

  it('returns undefined for an unparseable pattern rather than throwing', () => {
    const malformed: RosterEntry = { personId: 'x', name: 'X', expectedPattern: 'not a pattern' };
    expect(matchVisitor([malformed], tuesdayAt(9, 10))).toBeUndefined();
  });

  it('returns the first matching person when the roster has more than one', () => {
    const gardener: RosterEntry = { personId: 'sam', name: 'Sam', expectedPattern: 'TUE 09:00±30m' };
    expect(matchVisitor([maria, gardener], tuesdayAt(9, 10))?.personId).toBe('maria');
  });

  it('returns undefined for an empty roster', () => {
    expect(matchVisitor([], tuesdayAt(9, 10))).toBeUndefined();
  });
});

describe('matchVisitor — someone who said they were coming, once', () => {
  // Sarah told Wick she would come on Saturday 17 October 2026 at 15:00 (expect_visit).
  const sarah: RosterEntry = {
    personId: 'member-u_sarah',
    name: 'Sarah',
    expectedOnce: { at: Date.UTC(2026, 9, 17, 15), windowMin: 60 },
  };
  const saturdayAt = (hh: number, mm: number): number => Date.UTC(2026, 9, 17, hh, mm);

  it('matches a ring near the time they gave', () => {
    expect(matchVisitor([sarah], saturdayAt(15, 20))).toEqual({
      personId: 'member-u_sarah',
      name: 'Sarah',
      basis: 'schedule',
      expectedToday: true,
      confidence: 0.5,
    });
    expect(matchVisitor([sarah], saturdayAt(14, 0))).toMatchObject({ name: 'Sarah' });
  });

  it('does not match outside it, or the same hour a week later', () => {
    expect(matchVisitor([sarah], saturdayAt(16, 1))).toBeUndefined();
    expect(matchVisitor([sarah], saturdayAt(15, 0) + 7 * 86_400_000)).toBeUndefined();
  });

  it('still finds the regular visitor on a roster that has both', () => {
    expect(matchVisitor([sarah, maria], tuesdayAt(9, 10))).toMatchObject({ name: 'Maria' });
  });
});

describe('stillWelcome — a visit announced by someone no longer in the circle is not on the roster', () => {
  const sarah: RosterEntry = { personId: 'member-u_sarah', name: 'Sarah', expectedOnce: { at: 1, windowMin: 60 } };
  const tom: RosterEntry = { personId: 'member-u_tom', name: 'Tom', expectedOnce: { at: 2, windowMin: 60 } };
  const member = (userId: string, status: string) => ({ sk: { S: `MEM#${userId}` }, status: { S: status } });

  it('keeps the regular visitors, and the announced visits of people the resident still allows', () => {
    expect(stillWelcome([maria, sarah, tom], [member('u_sarah', 'allowed'), member('u_tom', 'removed')])).toEqual([maria, sarah]);
  });

  it('drops an announced visit whose author has no membership at all, or one still waiting', () => {
    expect(stillWelcome([sarah, tom], [member('u_tom', 'pending')])).toEqual([]);
  });
});
