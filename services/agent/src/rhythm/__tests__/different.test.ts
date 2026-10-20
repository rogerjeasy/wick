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
const visit = (when: number, personId = 'maria', name = 'Maria'): TimelineEntry => ({ at: when, kind: 'presence', summary: `Someone came to the door when ${name} was expected.`, personId, name });
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

const houseInput = input;

describe('a regular visitor who did not come', () => {
  // These times are written in UTC, and so is this house: nine o'clock here is nine o'clock there.
  const input = (over: Partial<DifferentInput>): DifferentInput => houseInput({ timeZone: 'UTC', ...over });

  it('counts her days where the house is: a carer due at nine in Los Angeles is not missed at half past four in the morning', () => {
    // Nine o'clock on a Los Angeles Friday is 16:00 UTC (PDT); she has come on Tuesdays and Fridays at five past nine there.
    const la = (day: number, hour: number, minute = 0): number => at(day, hour + 7, minute);
    const entries: TimelineEntry[] = [];
    for (let k = 1; k <= 6; k += 1) entries.push(visit(la(FRIDAY - k * WEEK, 9, 5)), visit(la(FRIDAY - 3 * DAY - k * WEEK, 9, 5)));
    entries.push(visit(la(FRIDAY - 3 * DAY, 9, 5)));
    const inLosAngeles = (now: number) => whatsDifferent(input({ entries, now, timeZone: 'America/Los_Angeles' })).differences;

    // 11:30 UTC is 04:30 on Friday morning in Los Angeles: her day has not come round yet.
    expect(inLosAngeles(at(FRIDAY, 11, 30))).toEqual([]);
    // 11:00 there, inside the grace: late, not missing.
    expect(inLosAngeles(la(FRIDAY, 11))).toEqual([]);
    // 14:00 there: her time and two hours more have gone by.
    expect(inLosAngeles(la(FRIDAY, 14))).toEqual([
      expect.objectContaining({ kind: 'missed_visit', sentence: 'Maria is usually expected on Friday mornings. Nobody has come to the door at that time today.', at: la(FRIDAY, 9) }),
    ]);
  });

  it('is said, plainly, once their time and two hours more have gone by', () => {
    const answer = whatsDifferent(input({ entries: mariaCame(6) }));

    expect(answer.differences).toEqual([
      {
        kind: 'missed_visit',
        factClass: 'PRESENCE',
        sentence: 'Maria is usually expected on Friday mornings. Nobody has come to the door at that time today.',
        lasting: 'Maria is usually expected on Friday mornings. Nobody came to the door at that time on Friday.',
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

    expect(sentence(at(FRIDAY + DAY, 10))).toBe('Maria is usually expected on Friday mornings. Nobody came to the door at that time yesterday.');
    expect(sentence(at(FRIDAY + 3 * DAY, 10))).toBe('Maria is usually expected on Friday mornings. Nobody came to the door at that time on Friday.');
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
    expect(lasting({ entries: mariaCame(6) })).toEqual(['Maria is usually expected on Friday mornings. Nobody came to the door at that time on Friday.']);
    expect(lasting({ entries: mariaCame(6), now: at(FRIDAY + DAY, 10) })).toEqual(['Maria is usually expected on Friday mornings. Nobody came to the door at that time on Friday.']);
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

// A day with no event is a quiet day or a day Wick could not see (packages/contracts heard.ts).
describe('the doorbell heard — nothing is said from an absence Wick could not see', () => {
  /** Every hour from eight weeks back to `until`, heard, except those from `silentFrom` to `silentTo`. */
  const heardHours = (until: number, silentFrom = Infinity, silentTo = Infinity): number[] => {
    const out: number[] = [];
    for (let h = FRIDAY - 8 * WEEK; h < until; h += HOUR) if (h + HOUR <= silentFrom || h >= silentTo) out.push(h);
    return out;
  };
  const NOW = at(FRIDAY, 14);
  const quietFriday = () => [1, 2, 3, 4, 5, 6].flatMap((k) => [door(at(FRIDAY - k * WEEK, 9)), door(at(FRIDAY - k * WEEK, 10)), door(at(FRIDAY - k * WEEK, 11))]);

  it('says Maria’s window had nobody at the door only when the doorbell was heard on both sides of it', () => {
    const heard = whatsDifferent(input({ timeZone: 'UTC', entries: mariaCame(6), now: NOW, heard: heardHours(NOW) }));
    expect(heard.differences.map((d) => d.kind)).toEqual(['missed_visit']);
    expect(heard.doorUnheard).toBeUndefined();
  });

  it('says nothing of her window when the doorbell went unheard through it — and says the doorbell is unheard', () => {
    const outage = whatsDifferent(input({ timeZone: 'UTC', entries: mariaCame(6), now: NOW, heard: heardHours(NOW, at(FRIDAY, 6)) }));
    expect(outage.differences).toEqual([]);
    expect(outage.doorUnheard).toEqual({ lastHeardAt: at(FRIDAY, 6) });
  });

  it('says nothing of her window when the doorbell came back only after it, without a word before', () => {
    const backAfter = whatsDifferent(input({ timeZone: 'UTC', entries: mariaCame(6), now: NOW, heard: heardHours(NOW, at(FRIDAY - DAY, 12), at(FRIDAY, 13)) }));
    expect(backAfter.differences.map((d) => d.kind)).not.toContain('missed_visit');
  });

  it('calls the door quiet only when the doorbell was heard through the day', () => {
    const entries = quietFriday();
    expect(whatsDifferent(input({ entries, now: NOW, heard: heardHours(NOW) })).differences.map((d) => d.kind)).toEqual(['door_quiet']);
    expect(whatsDifferent(input({ entries, now: NOW, heard: heardHours(NOW, at(FRIDAY, 1)) })).differences).toEqual([]);
  });

  it('counts the usual only from the weeks the doorbell was heard: three unheard Fridays are not three quiet ones', () => {
    // Three callers on each of the last three Fridays; the three before were unheard, and nobody has come today.
    const entries = quietFriday().filter((e) => e.at > FRIDAY - 3 * WEEK - DAY);
    const heardLately = heardHours(NOW).filter((h) => h >= FRIDAY - 3 * WEEK - DAY);
    expect(whatsDifferent(input({ roster: [], entries, now: NOW, heard: heardLately })).differences.map((d) => d.sentence)).toEqual([
      'Nobody has come to the door today. By this time on a Friday there are usually about 3.',
    ]);
    // Counted as quiet, the unheard Fridays would have halved the usual, and today would not have been news.
    expect(whatsDifferent(input({ roster: [], entries, now: NOW })).differences).toEqual([]);
  });

  it('keeps today’s rule for a caller that does not say what was heard', () => {
    expect(whatsDifferent(input({ timeZone: 'UTC', entries: mariaCame(6), now: NOW })).differences.map((d) => d.kind)).toEqual(['missed_visit']);
  });
});
