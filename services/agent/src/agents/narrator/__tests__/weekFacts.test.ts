import { describe, it, expect } from 'vitest';
import { MAX_NARRATIVE_CHARS, type RhythmDelta, type TimelineEntry } from '@wick/contracts';
import { checkNarrative, factLines, fallbackNarrative, privateNarrative, summariseWeek } from '../weekFacts.js';
import { isoWeekRange } from '../isoWeek.js';

// 2026-W40 runs Monday 28 Sep to Sunday 4 Oct. London is on BST (UTC+1).
const range = isoWeekRange('2026-W40');
const LONDON = 'Europe/London';
const door = (iso: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'door', summary: 'Someone was at the front door.' });
const visit = (iso: string, name: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'visit', summary: `${name} visited.`, personId: name.toLowerCase() });
const afterTheWeek = range.endMs + 60_000;

// The Rhythm baseline's answer for a week (rhythm/baseline.ts), with five weeks of history.
const usualDoor: RhythmDelta = { metric: 'door', label: 'the front door', thisWeek: 3, lastWeek: 4, baseline: 3.4, zScore: -0.4, baselineWeeks: 5, verdict: 'usual' };
const usualMaria: RhythmDelta = { metric: 'visit:maria', label: 'Maria', thisWeek: 1, lastWeek: 2, baseline: 1.6, zScore: -0.6, baselineWeeks: 5, verdict: 'usual' };
const absentMaria: RhythmDelta = { metric: 'visit:maria', label: 'Maria', thisWeek: 0, lastWeek: 2, baseline: 2, zScore: -2, baselineWeeks: 5, verdict: 'fewer' };

describe('summariseWeek', () => {
  it('groups door visits by the household’s own day and part of day, not UTC', () => {
    // 22:50 UTC Wednesday is 23:50 BST — still Wednesday night in London.
    // 23:30 UTC Wednesday is 00:30 BST Thursday — Thursday night in London.
    const facts = summariseWeek(
      [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), door('2026-09-30T22:50:00Z'), door('2026-09-30T23:30:00Z'), door('2026-10-01T07:40:00Z')],
      { timeZone: LONDON, range, now: afterTheWeek },
    );

    expect(facts.doorVisits).toBe(5);
    expect(facts.doorTimes).toEqual([
      { day: 'Wednesday', part: 'evening', count: 2 },
      { day: 'Wednesday', part: 'night', count: 1 },
      { day: 'Thursday', part: 'night', count: 1 },
      { day: 'Thursday', part: 'morning', count: 1 },
    ]);
  });

  it('counts named visits per person, in order of first arrival', () => {
    const facts = summariseWeek(
      [visit('2026-09-29T09:00:00Z', 'Maria'), visit('2026-10-01T09:00:00Z', 'Maria'), visit('2026-09-30T15:00:00Z', 'Tom')],
      { timeZone: LONDON, range, now: afterTheWeek },
    );

    expect(facts.visits).toEqual([{ name: 'Maria', count: 2 }, { name: 'Tom', count: 1 }]);
    expect(facts.doorVisits).toBe(0);
  });

  it('knows a mid-week run is only the week so far, and through which day', () => {
    const thursdayNoon = Date.parse('2026-10-01T11:00:00Z');
    const facts = summariseWeek([], { timeZone: LONDON, range, now: thursdayNoon });

    expect(facts.weekComplete).toBe(false);
    expect(facts.throughDay).toBe('Thursday');
  });

  it('knows a run after Sunday covers the whole week', () => {
    expect(summariseWeek([], { timeZone: LONDON, range, now: afterTheWeek }).weekComplete).toBe(true);
  });
});

describe('factLines', () => {
  it('states every number the model may use, and says when the week is not over', () => {
    const facts = summariseWeek(
      [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), visit('2026-09-29T09:00:00Z', 'Maria')],
      { timeZone: LONDON, range, now: Date.parse('2026-10-01T11:00:00Z') },
    );

    expect(factLines(facts)).toEqual([
      'This is the week so far: Monday to Thursday. The week is not over.',
      'Someone came to the front door 2 times.',
      'Wednesday evening: 2 times at the front door.',
      'Maria visited 1 time.',
    ]);
  });

  it('says plainly when nothing happened', () => {
    const facts = summariseWeek([], { timeZone: LONDON, range, now: afterTheWeek });
    expect(factLines(facts)).toEqual(['This is the whole week: Monday to Sunday.', 'Nobody came to the front door.']);
  });
});

describe('checkNarrative — the model never counts', () => {
  const facts = summariseWeek(
    [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), door('2026-10-01T07:40:00Z')],
    { timeZone: LONDON, range, now: afterTheWeek },
  );

  it('accepts prose that uses only the supplied numbers, in digits or words', () => {
    expect(checkNarrative('Someone came to the door three times: twice on Wednesday evening and once on Thursday morning.', facts)).toEqual({ ok: true });
    expect(checkNarrative('Someone came to the door 3 times this week.', facts)).toEqual({ ok: true });
  });

  it('rejects a number the facts never gave', () => {
    expect(checkNarrative('Six people came to the door.', facts)).toEqual({ ok: false, reason: 'unsupported_number', detail: 'Six' });
    expect(checkNarrative('Someone came at 9 o’clock.', facts)).toEqual({ ok: false, reason: 'unsupported_number', detail: '9' });
  });

  it('does not mistake "no one" or "someone" for a count', () => {
    expect(checkNarrative('No one rang on Monday; someone came on Wednesday evening.', facts)).toEqual({ ok: true });
  });

  it('rejects prose too long for the television card', () => {
    const long = 'A quiet evening at the door. '.repeat(10);
    expect(long.length).toBeGreaterThan(MAX_NARRATIVE_CHARS);
    expect(checkNarrative(long, facts)).toMatchObject({ ok: false, reason: 'too_long' });
  });

  it('rejects empty prose', () => {
    expect(checkNarrative('   ', facts)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('accepts last week\'s number and the usual one once the baseline supplies them', () => {
    const text = 'Someone came to the door three times, down from four last week and about the usual.';

    expect(checkNarrative(text, facts)).toMatchObject({ ok: false });
    expect(checkNarrative(text, facts, [usualDoor])).toEqual({ ok: true });
  });

  it('rejects a comparison the baseline does not support — the model never decides what is usual', () => {
    expect(checkNarrative('Someone came three times. Nothing unusual this week.', facts)).toEqual({
      ok: false, reason: 'unsupported_comparison', detail: 'unusual',
    });
    expect(checkNarrative('Someone came three times. Nothing unusual this week.', facts, [usualDoor, absentMaria])).toEqual({
      ok: false, reason: 'unsupported_comparison', detail: 'Nothing unusual',
    });
  });
});

describe('fallbackNarrative', () => {
  it('is written from the facts alone, and always passes its own check', () => {
    const facts = summariseWeek(
      [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), door('2026-10-01T07:40:00Z'), visit('2026-09-29T09:00:00Z', 'Maria')],
      { timeZone: LONDON, range, now: afterTheWeek },
    );
    const text = fallbackNarrative(facts);

    expect(text).toBe('Someone came to the front door three times this week: twice on Wednesday evening and once on Thursday morning. Maria visited once.');
    expect(checkNarrative(text, facts)).toEqual({ ok: true });
  });

  it('does not repeat the count when every visit fell in one part of one day', () => {
    const facts = summariseWeek([door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z')], { timeZone: LONDON, range, now: afterTheWeek });
    expect(fallbackNarrative(facts)).toBe('Someone came to the front door twice this week, on Wednesday evening.');
  });

  it('says a quiet week is a quiet week — and says "so far" mid-week', () => {
    expect(fallbackNarrative(summariseWeek([], { timeZone: LONDON, range, now: afterTheWeek }))).toBe('A quiet week. Nobody came to the front door.');
    expect(fallbackNarrative(summariseWeek([], { timeZone: LONDON, range, now: Date.parse('2026-10-01T11:00:00Z') }))).toBe(
      'A quiet week so far. Nobody has come to the front door since Monday.',
    );
  });

  it('stays inside the card however busy the week was', () => {
    const busy = Array.from({ length: 7 * 4 }, (_, i) => door(new Date(range.startMs + i * 6 * 3_600_000 + 3_600_000).toISOString()));
    const facts = summariseWeek(busy, { timeZone: LONDON, range, now: afterTheWeek });
    const text = fallbackNarrative(facts);

    expect(text.length).toBeLessThanOrEqual(MAX_NARRATIVE_CHARS);
    expect(checkNarrative(text, facts)).toEqual({ ok: true });
  });
});

describe('fallbackNarrative — with a Rhythm baseline', () => {
  const facts = summariseWeek(
    [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), door('2026-10-01T07:40:00Z'), visit('2026-09-29T09:00:00Z', 'Maria')],
    { timeZone: LONDON, range, now: afterTheWeek },
  );

  it('says nothing was unusual when nothing was, before spending the room on times of day', () => {
    const text = fallbackNarrative(facts, [usualDoor, usualMaria]);

    expect(text).toBe(
      'Someone came to the front door three times this week: twice on Wednesday evening and once on Thursday morning. Maria visited once. Nothing unusual this week.',
    );
    expect(checkNarrative(text, facts, [usualDoor, usualMaria])).toEqual({ ok: true });
  });

  it('says who usually comes and did not', () => {
    const noMaria = summariseWeek([door('2026-09-30T18:10:00Z')], { timeZone: LONDON, range, now: afterTheWeek });
    const deltas = [{ ...usualDoor, thisWeek: 1 }, absentMaria];
    const text = fallbackNarrative(noMaria, deltas);

    expect(text).toBe('Someone came to the front door once this week, on Wednesday evening. Maria did not visit, and usually comes about twice a week.');
    expect(checkNarrative(text, noMaria, deltas)).toEqual({ ok: true });
  });

  it('keeps the comparison and drops the times of day when the card cannot hold both', () => {
    const busy = Array.from({ length: 7 * 4 }, (_, i) => door(new Date(range.startMs + i * 6 * 3_600_000 + 3_600_000).toISOString()));
    const busyFacts = summariseWeek(busy, { timeZone: LONDON, range, now: afterTheWeek });
    const deltas: RhythmDelta[] = [{ ...usualDoor, thisWeek: 28, baseline: 27, lastWeek: 26 }];
    const text = fallbackNarrative(busyFacts, deltas);

    expect(text).toBe('Someone came to the front door 28 times this week. Nothing unusual this week.');
    expect(checkNarrative(text, busyFacts, deltas)).toEqual({ ok: true });
  });

  it('is unchanged for a household with no history', () => {
    const young: RhythmDelta[] = [{ metric: 'door', label: 'the front door', thisWeek: 3, baseline: 0, zScore: 0, baselineWeeks: 0 }];

    expect(fallbackNarrative(facts, young)).toBe(fallbackNarrative(facts));
  });
});

describe('privateNarrative — the family’s week when the resident keeps part of it private', () => {
  const facts = summariseWeek(
    [door('2026-09-30T18:10:00Z'), door('2026-09-30T18:40:00Z'), door('2026-10-01T07:40:00Z'), visit('2026-09-29T09:00:00Z', 'Maria')],
    { timeZone: LONDON, range, now: afterTheWeek },
  );

  it('leaves out the door, and says part of the week is private — never that nobody came', () => {
    const text = privateNarrative(facts, { door: true, visits: false });
    expect(text).toBe('Maria visited once. Some of this week is kept private.');
    expect(text).not.toMatch(/door|nobody/i);
  });

  it('leaves out who visited', () => {
    expect(privateNarrative(facts, { door: false, visits: true })).toBe(
      'Someone came to the front door three times this week: twice on Wednesday evening and once on Thursday morning. Some of this week is kept private.',
    );
  });

  it('says only that the week is private when nothing shared is left', () => {
    expect(privateNarrative(facts, { door: true, visits: true })).toBe('This week is kept private.');
  });

  it('never calls a week with something private in it "nothing unusual" — Wick cannot say that for the part it leaves out', () => {
    const busyDoor: RhythmDelta = { ...usualDoor, zScore: 3, verdict: 'more' };

    expect(privateNarrative(facts, { door: true, visits: false }, [busyDoor, usualMaria])).toBe('Maria visited once. Some of this week is kept private.');
    expect(privateNarrative(facts, { door: true, visits: false }, [usualDoor, usualMaria])).toBe('Maria visited once. Some of this week is kept private.');
  });

  it('still says what was out of the usual in the part that is shared, and nothing about the part that is not', () => {
    const noMaria = summariseWeek([door('2026-09-30T18:10:00Z')], { timeZone: LONDON, range, now: afterTheWeek });
    const busyDoor: RhythmDelta = { ...usualDoor, thisWeek: 1, zScore: 3, verdict: 'more' };

    expect(privateNarrative(noMaria, { door: true, visits: false }, [busyDoor, absentMaria])).toBe(
      'Maria did not visit, and usually comes about twice a week. Some of this week is kept private.',
    );
    expect(privateNarrative(noMaria, { door: false, visits: true }, [busyDoor, absentMaria])).toBe(
      'Someone came to the front door once this week, on Wednesday evening. The front door had more callers than usual. Some of this week is kept private.',
    );
  });
});
