import { describe, it, expect } from 'vitest';
import { MAX_NARRATIVE_CHARS, type TimelineEntry } from '@wick/contracts';
import { checkNarrative, factLines, fallbackNarrative, summariseWeek } from '../weekFacts.js';
import { isoWeekRange } from '../isoWeek.js';

// 2026-W40 runs Monday 28 Sep to Sunday 4 Oct. London is on BST (UTC+1).
const range = isoWeekRange('2026-W40');
const LONDON = 'Europe/London';
const door = (iso: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'door', summary: 'Someone was at the front door.' });
const visit = (iso: string, name: string): TimelineEntry => ({ at: Date.parse(iso), kind: 'visit', summary: `${name} visited.`, personId: name.toLowerCase() });
const afterTheWeek = range.endMs + 60_000;

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
