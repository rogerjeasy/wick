import { describe, it, expect } from 'vitest';
import { MAX_NARRATIVE_CHARS, type RhythmDelta, type TimelineEntry } from '@wick/contracts';
import { checkNarrative, factLines, fallbackNarrative, privateNarrative, refusalReason, summariseWeek } from '../weekFacts.js';
import { isoWeekRange } from '../isoWeek.js';

// 2026-W40 runs Monday 28 Sep to Sunday 4 Oct. London is on BST (UTC+1).
const range = isoWeekRange('2026-W40');
const LONDON = 'Europe/London';
const door = (iso: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'door', summary: 'Someone was at the front door.' });
/** A visit she confirmed on the television (narrator/timeline.ts, a VISIT# row answered "Yes, that's right"). */
const confirmedVisit = (iso: string, name: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'visit', summary: `${name} came, as confirmed on the television.`, personId: name.toLowerCase(), name });
/** Somebody at the door when the visitor was expected: a presence row. When, never who. */
const visit = (iso: string, name: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'presence', summary: `Someone came to the door when ${name} was expected.`, personId: name.toLowerCase(), name });
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

  it('counts the door when each visitor was expected per person, in order of first arrival — and the visits she confirmed apart', () => {
    const facts = summariseWeek(
      [visit('2026-09-29T09:00:00Z', 'Maria'), visit('2026-10-01T09:00:00Z', 'Maria'), visit('2026-09-30T15:00:00Z', 'Tom'), confirmedVisit('2026-09-29T09:00:00Z', 'Maria')],
      { timeZone: LONDON, range, now: afterTheWeek },
    );

    expect(facts.whenExpected).toEqual([{ name: 'Maria', count: 2 }, { name: 'Tom', count: 1 }]);
    expect(facts.confirmed).toEqual([{ name: 'Maria', count: 1 }]);
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

  it('tells Sunday evening’s run as the week: it is read that evening, and all the week after', () => {
    // The Narrator's own hour (infra/narrator.tf): Sunday 20:00 UTC.
    const sundayEvening = Date.parse('2026-10-04T20:00:00Z');
    const facts = summariseWeek([door('2026-09-30T09:00:00Z')], { timeZone: LONDON, range, now: sundayEvening });

    expect(facts).toMatchObject({ weekComplete: true, throughDay: 'Sunday' });
    expect(fallbackNarrative(facts)).toBe('Someone came to the front door once this week, on Wednesday morning.');
  });

  it('still calls Sunday afternoon the week so far', () => {
    const sundayAfternoon = Date.parse('2026-10-04T15:00:00Z');

    expect(summariseWeek([], { timeZone: LONDON, range, now: sundayAfternoon }).weekComplete).toBe(false);
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
      'Someone came to the door 1 time when Maria was expected. That alone does not say who it was.',
      'Nobody has confirmed that Maria came this week. Never write that Maria came or visited.',
    ]);
  });

  it('says a visit she confirmed as the visitor coming, and only that one', () => {
    const facts = summariseWeek(
      [visit('2026-09-29T09:00:00Z', 'Maria'), confirmedVisit('2026-09-29T09:00:00Z', 'Maria')],
      { timeZone: LONDON, range, now: afterTheWeek },
    );
    expect(factLines(facts)).toEqual([
      'This is the whole week: Monday to Sunday.',
      'Nobody came to the front door.',
      'Someone came to the door 1 time when Maria was expected. That alone does not say who it was.',
      'The resident confirmed on the television that Maria came 1 time.',
    ]);
  });

  it('says plainly when nothing happened', () => {
    const facts = summariseWeek([], { timeZone: LONDON, range, now: afterTheWeek });
    expect(factLines(facts)).toEqual(['This is the whole week: Monday to Sunday.', 'Nobody came to the front door.']);
  });
});

describe('checkNarrative — nobody is said to have come on the door’s word alone', () => {
  const atDoor = summariseWeek([visit('2026-09-29T09:00:00Z', 'Maria'), visit('2026-10-01T09:00:00Z', 'Maria')], { timeZone: LONDON, range, now: afterTheWeek });

  it('refuses a draft that says a visitor came, visited or was here when she confirmed none of it', () => {
    for (const draft of ['Maria visited twice this week.', 'A quiet week. Maria came twice.', 'Maria was here on Tuesday and Thursday.', 'Maria stopped by twice.', 'Maria did not visit this week.']) {
      const check = checkNarrative(draft, atDoor);
      expect(check, draft).toMatchObject({ ok: false, reason: 'unconfirmed_visit' });
    }
  });

  it('lets the facts’ own words through, and a sentence that says it is not confirmed', () => {
    for (const draft of [
      'Someone came to the door twice when Maria was expected.',
      'The doorbell rang twice at the times Maria was expected, though nobody has confirmed it was her.',
      fallbackNarrative(atDoor),
    ]) {
      expect(checkNarrative(draft, atDoor), draft).toEqual({ ok: true });
    }
  });

  it('lets a visit she confirmed be told as the visitor coming', () => {
    const confirmed = summariseWeek([visit('2026-09-29T09:00:00Z', 'Maria'), confirmedVisit('2026-09-29T09:00:00Z', 'Maria')], { timeZone: LONDON, range, now: afterTheWeek });
    expect(checkNarrative('Maria came once this week.', confirmed)).toEqual({ ok: true });
    expect(fallbackNarrative(confirmed)).toBe('A quiet week. Nobody came to the front door. Maria came once, as confirmed on the television.');
  });

  it('tells the model why, in words it can act on', () => {
    const check = checkNarrative('Maria visited twice this week.', atDoor);
    if (check.ok) throw new Error('expected a refusal');
    expect(refusalReason(check)).toBe('Your draft said "Maria visited twice this week.", but nobody confirmed who came. Say that someone came to the door when they were expected, as the facts do.');
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

  it('tells a writer whose draft was too long what the limit is, and how far over it went', () => {
    // Live, the writer's first draft ran 261 and 263 characters, and "stay under the limit" named no number.
    expect(refusalReason({ ok: false, reason: 'too_long', detail: String(MAX_NARRATIVE_CHARS + 21) })).toBe(
      `Your draft was ${MAX_NARRATIVE_CHARS + 21} characters, 21 over the limit of ${MAX_NARRATIVE_CHARS}. Cut a clause or a sentence.`,
    );
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

    expect(text).toBe('Someone came to the front door three times this week: twice on Wednesday evening and once on Thursday morning. Someone came to the door once when Maria was expected.');
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
      'Someone came to the front door three times this week: twice on Wednesday evening and once on Thursday morning. Someone came to the door once when Maria was expected. Nothing unusual this week.',
    );
    expect(checkNarrative(text, facts, [usualDoor, usualMaria])).toEqual({ ok: true });
  });

  it('says who usually comes and did not', () => {
    const noMaria = summariseWeek([door('2026-09-30T18:10:00Z')], { timeZone: LONDON, range, now: afterTheWeek });
    const deltas = [{ ...usualDoor, thisWeek: 1 }, absentMaria];
    const text = fallbackNarrative(noMaria, deltas);

    expect(text).toBe('Someone came to the front door once this week, on Wednesday evening. Nobody came to the door when Maria was expected; usually someone does, about twice a week.');
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
    expect(text).toBe('Someone came once when Maria was expected. Some of this week is kept private.');
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

    expect(privateNarrative(facts, { door: true, visits: false }, [busyDoor, usualMaria])).toBe('Someone came once when Maria was expected. Some of this week is kept private.');
    expect(privateNarrative(facts, { door: true, visits: false }, [usualDoor, usualMaria])).toBe('Someone came once when Maria was expected. Some of this week is kept private.');
  });

  it('still says what was out of the usual in the part that is shared, and nothing about the part that is not', () => {
    const noMaria = summariseWeek([door('2026-09-30T18:10:00Z')], { timeZone: LONDON, range, now: afterTheWeek });
    const busyDoor: RhythmDelta = { ...usualDoor, thisWeek: 1, zScore: 3, verdict: 'more' };

    expect(privateNarrative(noMaria, { door: true, visits: false }, [busyDoor, absentMaria])).toBe(
      'Nobody came to the door when Maria was expected; usually someone does, about twice a week. Some of this week is kept private.',
    );
    expect(privateNarrative(noMaria, { door: false, visits: true }, [busyDoor, absentMaria])).toBe(
      'Someone came to the front door once this week, on Wednesday evening. The front door had more callers than usual. Some of this week is kept private.',
    );
  });
});
