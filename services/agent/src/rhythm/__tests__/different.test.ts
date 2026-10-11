import { describe, expect, it } from 'vitest';
import type { RosterEntry, TimelineEntry } from '@wick/contracts';
import { parsePattern, whatsDifferent, type DifferentInput } from '../different.js';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const HOUR = 3_600_000;

/** Friday 9 October 2026, midnight UTC. */
const FRIDAY = Date.UTC(2026, 9, 9);
const at = (day: number, hour: number, minute = 0): number => day + hour * HOUR + minute * 60_000;

const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE,FRI 09:00±30m' };
const visit = (when: number, personId = 'maria', name = 'Maria'): TimelineEntry => ({ at: when, kind: 'visit', summary: `${name} visited.`, personId });
const door = (when: number): TimelineEntry => ({ at: when, kind: 'door', summary: 'Someone was at the front door.' });

/** Maria on every Tuesday and Friday at five past nine, for `weeks` weeks before this Friday. */
function mariaCame(weeks: number, { thisTuesday = true } = {}): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (let k = 1; k <= weeks; k += 1) {
    out.push(visit(at(FRIDAY - k * WEEK, 9, 5)), visit(at(FRIDAY - 3 * DAY - k * WEEK, 9, 5)));
  }
  if (thisTuesday) out.push(visit(at(FRIDAY - 3 * DAY, 9, 5)));
  return out;
}

const input = (over: Partial<DifferentInput>): DifferentInput => ({
  entries: [],
  roster: [maria],
  now: at(FRIDAY, 14),
  observedSince: FRIDAY - 8 * WEEK,
  timeZone: 'Europe/London',
  ...over,
});

describe('a regular visitor who did not come', () => {
  it('is said, plainly, once their time and two hours more have gone by', () => {
    const answer = whatsDifferent(input({ entries: mariaCame(6) }));

    expect(answer.differences).toEqual([
      {
        kind: 'missed_visit',
        factClass: 'PRESENCE',
        sentence: 'Maria usually comes on Friday mornings. There has been no visit today.',
        lasting: 'Maria usually comes on Friday mornings. There was no visit on Friday.',
        at: at(FRIDAY, 9),
        personId: 'maria',
      },
    ]);
  });

  it('is not said while she may still be on her way', () => {
    // Half past nine closes her window; until half past eleven she is late, not missing.
    expect(whatsDifferent(input({ entries: mariaCame(6), now: at(FRIDAY, 11) })).differences).toEqual([]);
  });

  it('is not said when she came late', () => {
    const entries = [...mariaCame(6), visit(at(FRIDAY, 13))];

    expect(whatsDifferent(input({ entries })).differences).toEqual([]);
  });

  it('is not said when she came on another day since', () => {
    const saturday = FRIDAY + DAY;
    const entries = [...mariaCame(6), visit(at(saturday, 10))];

    expect(whatsDifferent(input({ entries, now: at(saturday, 15) })).differences).toEqual([]);
  });

  it('names the day once it is no longer today', () => {
    const sentence = (now: number) => whatsDifferent(input({ entries: mariaCame(6), now })).differences[0]?.sentence;

    expect(sentence(at(FRIDAY + DAY, 10))).toBe('Maria usually comes on Friday mornings. There was no visit yesterday.');
    expect(sentence(at(FRIDAY + 3 * DAY, 10))).toBe('Maria usually comes on Friday mornings. There was no visit on Friday.');
  });

  it('needs a habit, not a schedule: three visits on that weekday before it is hers', () => {
    // Somebody typed "Tuesdays and Fridays" in two weeks ago. Two Fridays are not a rhythm.
    expect(whatsDifferent(input({ entries: mariaCame(2) })).differences).toEqual([]);
    expect(whatsDifferent(input({ entries: mariaCame(3) })).differences).toHaveLength(1);
  });

  it('says nothing about a visit somebody announced once — that is a plan, not a rhythm', () => {
    const once: RosterEntry = { personId: 'member-u1#2026-10-09', name: 'Sarah', expectedOnce: { at: at(FRIDAY, 9), windowMin: 30 } };

    expect(whatsDifferent(input({ roster: [once] })).differences).toEqual([]);
  });
});

describe('somebody at the door in the night', () => {
  // Ten past two in the morning in London, which in October is ten past one UTC.
  const inTheNight = at(FRIDAY, 1, 10);

  it('is said in a house where nobody comes at night', () => {
    const answer = whatsDifferent(input({ roster: [], entries: [door(inTheNight)], now: at(FRIDAY, 8) }));

    expect(answer.differences).toEqual([
      {
        kind: 'door_at_night',
        factClass: 'DOOR_EVENT',
        sentence: 'Someone came to the door in the night, at 2:10 am. Nobody had come at night in the 6 weeks before.',
        lasting: 'Someone came to the door in the night, at 2:10 am on Friday. Nobody had come at night in the 6 weeks before.',
        at: inTheNight,
      },
    ]);
  });

  it('is not different in a house where people do come at night', () => {
    const entries = [door(inTheNight), door(inTheNight - 3 * WEEK)];

    expect(whatsDifferent(input({ roster: [], entries, now: at(FRIDAY, 8) })).differences).toEqual([]);
  });

  it('is not said about a call in the daytime, or one more than a day old', () => {
    expect(whatsDifferent(input({ roster: [], entries: [door(at(FRIDAY, 7))], now: at(FRIDAY, 8) })).differences).toEqual([]);
    expect(whatsDifferent(input({ roster: [], entries: [door(inTheNight - 2 * DAY)], now: at(FRIDAY, 8) })).differences).toEqual([]);
  });
});

describe('a day at the door unlike the same weekday usually is', () => {
  /** `perFriday` callers before two in the afternoon on each of the six Fridays before. */
  const usualFridays = (perFriday: number): TimelineEntry[] =>
    [1, 2, 3, 4, 5, 6].flatMap((k) => Array.from({ length: perFriday }, (_, i) => door(at(FRIDAY - k * WEEK, 9 + i))));

  it('says a quiet day, against the same stretch of the Fridays before', () => {
    const answer = whatsDifferent(input({ roster: [], entries: usualFridays(3) }));

    expect(answer.differences.map((d) => [d.kind, d.sentence])).toEqual([
      ['door_quiet', 'Nobody has come to the door today. By this time on a Friday there are usually about 3.'],
    ]);
  });

  it('says a busy one', () => {
    const today = [9, 10, 11, 12, 13].map((h) => door(at(FRIDAY, h)));
    const answer = whatsDifferent(input({ roster: [], entries: [...usualFridays(1), ...today] }));

    expect(answer.differences.map((d) => [d.kind, d.sentence])).toEqual([
      ['door_busy', 'The door has been busier than usual today: 5 callers. By this time on a Friday there are usually about 1.'],
    ]);
  });

  it('never calls a day different for one caller more or fewer', () => {
    const today = [door(at(FRIDAY, 9)), door(at(FRIDAY, 10))];

    expect(whatsDifferent(input({ roster: [], entries: [...usualFridays(3), ...today] })).differences).toEqual([]);
  });

  it('does not compare a morning with whole days: callers later on the earlier Fridays do not count yet', () => {
    // Three callers every Friday, all in the evening. At two in the afternoon none of them had come.
    const evenings = [1, 2, 3, 4, 5, 6].flatMap((k) => [18, 19, 20].map((h) => door(at(FRIDAY - k * WEEK, h))));

    expect(whatsDifferent(input({ roster: [], entries: evenings })).differences).toEqual([]);
  });
});

describe('whatsDifferent', () => {
  it('calls nothing different before there are three weeks to compare with', () => {
    const answer = whatsDifferent(input({ entries: mariaCame(2), observedSince: FRIDAY - 2 * WEEK - DAY }));

    expect(answer).toEqual({ weeksObserved: 2, enoughHistory: false, differences: [] });
  });

  it('has nothing to say on a usual day — which is also an answer', () => {
    const entries = [...mariaCame(6), visit(at(FRIDAY, 9, 5))];

    expect(whatsDifferent(input({ entries }))).toEqual({ weeksObserved: 6, enoughHistory: true, differences: [] });
  });

  it('puts the visitor who did not come before anything about the door', () => {
    const fridays = [1, 2, 3, 4, 5, 6].flatMap((k) => [9, 10, 11].map((h) => door(at(FRIDAY - k * WEEK, h))));
    const answer = whatsDifferent(input({ entries: [...mariaCame(6), ...fridays] }));

    expect(answer.differences.map((d) => d.kind)).toEqual(['missed_visit', 'door_quiet']);
  });
});

describe('parsePattern', () => {
  it('reads the days, the time and the window', () => {
    expect(parsePattern('TUE,FRI 09:00±30m')).toEqual({ days: [2, 5], minuteOfDay: 540, windowMin: 30 });
  });

  it('gives nothing for a pattern it cannot read', () => {
    expect(parsePattern('every other day')).toBeUndefined();
    expect(parsePattern(undefined)).toBeUndefined();
  });
});

describe('the lasting wording — the same difference, said so that it is still true when read on another day', () => {
  const usualFridays = (perFriday: number): TimelineEntry[] =>
    [1, 2, 3, 4, 5, 6].flatMap((k) => Array.from({ length: perFriday }, (_, i) => door(at(FRIDAY - k * WEEK, 9 + i))));
  const lasting = (over: Partial<DifferentInput>) => whatsDifferent(input(over)).differences.map((d) => d.lasting);

  it('names the day of a missed visit, whichever day it is said on', () => {
    expect(lasting({ entries: mariaCame(6) })).toEqual(['Maria usually comes on Friday mornings. There was no visit on Friday.']);
    expect(lasting({ entries: mariaCame(6), now: at(FRIDAY + DAY, 10) })).toEqual(['Maria usually comes on Friday mornings. There was no visit on Friday.']);
  });

  it('names the day and the hour a quiet door was noticed, in the household’s own time', () => {
    // Two in the afternoon UTC is three in London's summer.
    expect(lasting({ roster: [], entries: usualFridays(3) })).toEqual([
      'Nobody had come to the door by 3:00 pm on Friday. By that time on a Friday there are usually about 3.',
    ]);
    expect(lasting({ roster: [], entries: [...usualFridays(4), door(at(FRIDAY, 9))] })).toEqual([
      'Fewer people than usual had come to the door by 3:00 pm on Friday: 1. By that time on a Friday there are usually about 4.',
    ]);
  });

  it('names the day and the hour a busy door was noticed', () => {
    const today = [9, 10, 11, 12, 13].map((h) => door(at(FRIDAY, h)));

    expect(lasting({ roster: [], entries: [...usualFridays(1), ...today] })).toEqual([
      'The door was busier than usual on Friday: 5 callers by 3:00 pm. By that time on a Friday there are usually about 1.',
    ]);
  });
});
