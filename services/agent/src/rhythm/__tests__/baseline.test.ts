import { describe, it, expect } from 'vitest';
import type { TimelineEntry } from '@wick/contracts';
import { baselineWindow, deltaFor, weekDeltas } from '../baseline.js';

const WEEK = 7 * 86_400_000;
const DAY = 86_400_000;
// 2026-W41 is Monday 5 Oct to Sunday 11 Oct.
const W41 = { startMs: Date.UTC(2026, 9, 5), endMs: Date.UTC(2026, 9, 12) };
const AFTER_W41 = W41.endMs + 3_600_000;

const door = (at: number): TimelineEntry => ({ at, kind: 'door', summary: 'Someone was at the front door.' });
const visit = (at: number, personId = 'maria', name = 'Maria'): TimelineEntry => ({ at, kind: 'presence', summary: `Someone came to the door when ${name} was expected.`, personId, name });
/** `n` door events on the Wednesday of the week `weeksAgo` weeks before W41. */
const doors = (weeksAgo: number, n: number): TimelineEntry[] =>
  Array.from({ length: n }, (_, i) => door(W41.startMs - weeksAgo * WEEK + 2 * DAY + i * 60_000));

describe('deltaFor', () => {
  it('reports the mean of the weeks it has, and how many there were', () => {
    const delta = deltaFor({ metric: 'door', label: 'the front door', thisWeek: 4, priorWeeks: [3, 5, 4] });

    expect(delta).toMatchObject({ metric: 'door', label: 'the front door', thisWeek: 4, lastWeek: 3, baseline: 4, baselineWeeks: 3, verdict: 'usual' });
  });

  it('gives no verdict from fewer than three weeks — a false "something is different" is worse than none', () => {
    const delta = deltaFor({ metric: 'door', label: 'the front door', thisWeek: 14, priorWeeks: [0, 1] });

    expect(delta.verdict).toBeUndefined();
    expect(delta.zScore).toBe(0);
    expect(delta.lastWeek).toBe(0);
    expect(delta.baselineWeeks).toBe(2);
  });

  it('has no last week and no baseline when nothing before this week was observed', () => {
    const delta = deltaFor({ metric: 'door', label: 'the front door', thisWeek: 2, priorWeeks: [] });

    expect(delta).toMatchObject({ thisWeek: 2, baseline: 0, baselineWeeks: 0, zScore: 0 });
    expect(delta.lastWeek).toBeUndefined();
    expect(delta.verdict).toBeUndefined();
  });

  it('calls a carer who always comes twice and did not come at all "fewer"', () => {
    const delta = deltaFor({ metric: 'visit:maria', label: 'Maria', thisWeek: 0, priorWeeks: [2, 2, 2, 2] });

    expect(delta.verdict).toBe('fewer');
    expect(delta.zScore).toBe(-2);
  });

  it('never calls a week unusual for differing from a steady pattern by one', () => {
    expect(deltaFor({ metric: 'visit:maria', label: 'Maria', thisWeek: 1, priorWeeks: [2, 2, 2, 2] }).verdict).toBe('usual');
    expect(deltaFor({ metric: 'visit:maria', label: 'Maria', thisWeek: 3, priorWeeks: [2, 2, 2, 2] }).verdict).toBe('usual');
  });

  it('measures against the household\'s own spread: a busy door in a house whose weeks vary is still usual', () => {
    // mean 5, sample sd ≈ 3.16
    expect(deltaFor({ metric: 'door', label: 'the front door', thisWeek: 10, priorWeeks: [1, 5, 9, 5] }).verdict).toBe('usual');
    expect(deltaFor({ metric: 'door', label: 'the front door', thisWeek: 12, priorWeeks: [1, 5, 9, 5] }).verdict).toBe('more');
  });
});

describe('baselineWindow', () => {
  it('reaches six weeks back from the start of the week, to the end of it', () => {
    expect(baselineWindow(W41)).toEqual({ startMs: W41.startMs - 6 * WEEK, endMs: W41.endMs });
  });
});

describe('weekDeltas', () => {
  it('counts the front door this week against each whole week before it', () => {
    const entries = [...doors(0, 4), ...doors(1, 3), ...doors(2, 5), ...doors(3, 4)];

    const [delta] = weekDeltas(entries, { range: W41, now: AFTER_W41, observedSince: W41.startMs - 10 * WEEK });

    expect(delta).toMatchObject({ metric: 'door', thisWeek: 4, lastWeek: 3, baselineWeeks: 6 });
    // 3 + 5 + 4 over six observed weeks, three of them quiet
    expect(delta!.baseline).toBe(2);
  });

  it('does not count weeks before Wick was watching as quiet weeks', () => {
    // The first event ever was the Wednesday three weeks ago: only the two
    // whole weeks since were observed from their Monday.
    const firstEver = W41.startMs - 3 * WEEK + 2 * DAY;
    const entries = [...doors(0, 1), ...doors(1, 3), ...doors(3, 6)];

    const [delta] = weekDeltas(entries, { range: W41, now: AFTER_W41, observedSince: firstEver });

    expect(delta).toMatchObject({ baselineWeeks: 2, lastWeek: 3, baseline: 1.5 });
    expect(delta!.verdict).toBeUndefined();
  });

  it('has no baseline at all for a household nothing has ever been recorded for', () => {
    expect(weekDeltas([], { range: W41, now: AFTER_W41, observedSince: undefined })).toEqual([
      { metric: 'door', label: 'the front door', thisWeek: 0, baseline: 0, zScore: 0, baselineWeeks: 0 },
    ]);
  });

  it('compares a week that is not over with the same days of the weeks before, not their whole', () => {
    // Wednesday noon: an earlier week's Friday visit has not "happened yet".
    const now = W41.startMs + 2 * DAY + 12 * 3_600_000;
    const entries = [
      door(W41.startMs + DAY),
      door(W41.startMs - WEEK + DAY),
      door(W41.startMs - WEEK + 4 * DAY),
    ];

    const [delta] = weekDeltas(entries, { range: W41, now, observedSince: W41.startMs - 10 * WEEK });

    expect(delta).toMatchObject({ thisWeek: 1, lastWeek: 1 });
  });

  it('keeps a known visitor who did not come this week — the absence is the news', () => {
    const entries = [1, 2, 3].flatMap((w) => [visit(W41.startMs - w * WEEK + DAY), visit(W41.startMs - w * WEEK + 4 * DAY)]);

    const deltas = weekDeltas(entries, { range: W41, now: AFTER_W41, observedSince: W41.startMs - 3 * WEEK });

    expect(deltas.map((d) => d.metric)).toEqual(['door', 'visit:maria']);
    expect(deltas[1]).toMatchObject({ label: 'Maria', thisWeek: 0, lastWeek: 2, baseline: 2, baselineWeeks: 3, verdict: 'fewer' });
  });

  it('counts each named visitor separately, and never an unnamed one', () => {
    const entries = [
      visit(W41.startMs + DAY),
      visit(W41.startMs + 2 * DAY, 'tom', 'Tom'),
      { at: W41.startMs + 3 * DAY, kind: 'visit', summary: 'Someone visited.' } satisfies TimelineEntry,
    ];

    const deltas = weekDeltas(entries, { range: W41, now: AFTER_W41, observedSince: W41.startMs });

    expect(deltas.map((d) => [d.metric, d.label, d.thisWeek])).toEqual([
      ['door', 'the front door', 0],
      ['visit:maria', 'Maria', 1],
      ['visit:tom', 'Tom', 1],
    ]);
  });
});
