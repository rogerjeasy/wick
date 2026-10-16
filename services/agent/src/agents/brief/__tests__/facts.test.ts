import { describe, expect, it } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { RhythmDelta } from '@wick/contracts';
import { FILM_LINE, errandLines, missedUsualVisit, readErrandRow, watchedFilms } from '../facts.js';

// 2026-W38: Monday 14 to Sunday 20 September.
const W38 = { startMs: Date.UTC(2026, 8, 14), endMs: Date.UTC(2026, 8, 21) };
const THURSDAY_TEN = Date.UTC(2026, 8, 17, 9);

type Item = Record<string, AttributeValue>;

const errandItem = (over: Record<string, unknown> = {}): Item => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: 'ERRAND#err_AAAAAAAAAAAAAAAAAAAA' },
  data: {
    S: JSON.stringify({
      errandId: 'err_AAAAAAAAAAAAAAAAAAAA',
      householdId: 'hh-1',
      createdBy: 'u1',
      createdByName: 'Sarah',
      who: 'the plumber',
      at: THURSDAY_TEN,
      windowMinutes: 60,
      tellMe: true,
      status: 'rang',
      rangAt: THURSDAY_TEN + 240_000,
      createdAt: THURSDAY_TEN - 86_400_000,
      ...over,
    }),
  },
});

describe('readErrandRow — an errand row, read rather than trusted', () => {
  it('reads an errand kept as one JSON blob', () => {
    expect(readErrandRow(errandItem())).toEqual({ who: 'the plumber', createdByName: 'Sarah', at: THURSDAY_TEN, status: 'rang' });
  });

  it('reads an errand kept as attributes, the other shape a row could take', () => {
    const item: Item = {
      pk: { S: 'HH#hh-1' },
      sk: { S: 'ERRAND#err_BBBBBBBBBBBBBBBBBBBB' },
      who: { S: 'the window cleaner' },
      createdByName: { S: 'Tom' },
      at: { N: String(THURSDAY_TEN) },
      status: { S: 'no_show' },
    };
    expect(readErrandRow(item)).toEqual({ who: 'the window cleaner', createdByName: 'Tom', at: THURSDAY_TEN, status: 'no_show' });
  });

  it('leaves out a row it cannot read: no status it knows, no time, no one, or not an errand at all', () => {
    expect(readErrandRow(errandItem({ status: 'arrived' }))).toBeUndefined();
    expect(readErrandRow(errandItem({ at: 'Thursday' }))).toBeUndefined();
    expect(readErrandRow(errandItem({ who: '' }))).toBeUndefined();
    expect(readErrandRow(errandItem({ who: 'x'.repeat(41) }))).toBeUndefined();
    expect(readErrandRow({ ...errandItem(), sk: { S: 'PER#maria' } })).toBeUndefined();
    expect(readErrandRow({ pk: { S: 'HH#hh-1' }, sk: { S: 'ERRAND#x' }, data: { S: '{not json' } })).toBeUndefined();
  });
});

describe('errandLines — the visits the family arranged that week, and how each ended', () => {
  const errand = (status: string, at = THURSDAY_TEN, who = 'the plumber') => readErrandRow(errandItem({ status, at, who }))!;

  it('says what the door saw, never that the visitor came, and never which member arranged it', () => {
    expect(errandLines([errand('rang')], W38)).toEqual([
      'A visit from the plumber was arranged: someone rang the doorbell around the time they were expected.',
    ]);
    expect(errandLines([errand('no_show')], W38)).toEqual([
      'A visit from the plumber was arranged: nobody rang the doorbell while they were expected.',
    ]);
    for (const line of errandLines([errand('rang'), errand('no_show')], W38)) expect(line).not.toContain('Sarah');
  });

  it('says nothing of an errand called off — by its author, or closed because its author is no longer allowed — nor of one still under way or failed', () => {
    for (const status of ['cancelled', 'planned', 'reminded', 'waiting', 'failed']) expect(errandLines([errand(status)], W38)).toEqual([]);
  });

  it('keeps to the week, in the order the visits were due, and carries no number', () => {
    const lines = errandLines(
      [errand('no_show', THURSDAY_TEN + 86_400_000, 'the nurse'), errand('rang'), errand('rang', W38.endMs, 'next week'), errand('rang', W38.startMs - 1, 'last week')],
      W38,
    );
    expect(lines).toEqual([
      'A visit from the plumber was arranged: someone rang the doorbell around the time they were expected.',
      'A visit from the nurse was arranged: nobody rang the doorbell while they were expected.',
    ]);
    expect(lines.join(' ')).not.toMatch(/\d/);
  });
});

describe('watchedFilms — whether a film was played on her television that week', () => {
  const activity = (measure: string, lastSeenAt: number): Item => ({
    pk: { S: 'HH#hh-1' },
    sk: { S: `RHYTHM#tv_activity#wick-tv#${measure}#THU-15` },
    count: { N: '4' },
    lastSeenAt: { N: String(lastSeenAt) },
  });

  it('is true when a film was last played in the week', () => {
    expect(watchedFilms([activity('power_on', THURSDAY_TEN)], W38)).toBe(true);
  });

  it('is false when the only films were played before the week, or the television was only switched to', () => {
    expect(watchedFilms([activity('power_on', W38.startMs - 1)], W38)).toBe(false);
    expect(watchedFilms([activity('foreground', THURSDAY_TEN)], W38)).toBe(false);
    expect(watchedFilms([], W38)).toBe(false);
  });

  it('is said as a fact with no number in it', () => {
    expect(FILM_LINE).not.toMatch(/\d/);
  });
});

describe('missedUsualVisit — whether someone who usually visits came less than usual', () => {
  const delta = (over: Partial<RhythmDelta>): RhythmDelta => ({ metric: 'visit:maria', label: 'Maria', thisWeek: 1, baseline: 2, zScore: -3, baselineWeeks: 6, verdict: 'fewer', ...over });

  it('is true only when the baseline itself says a visitor came fewer times than usual', () => {
    expect(missedUsualVisit([delta({})])).toBe(true);
    expect(missedUsualVisit([delta({ verdict: 'usual' })])).toBe(false);
    // Below three weeks there is no usual week, so nobody can be said to have missed one.
    expect(missedUsualVisit([{ metric: 'visit:maria', label: 'Maria', thisWeek: 0, baseline: 2, zScore: 0, baselineWeeks: 2 }])).toBe(false);
    // Fewer callers at the door is not a missed visit.
    expect(missedUsualVisit([delta({ metric: 'door', label: 'the front door' })])).toBe(false);
  });
});
