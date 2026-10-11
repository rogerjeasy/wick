import { describe, it, expect, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { computeWeekNarrative, factsWeekNarrative, type NarratorDeps } from '../index.js';

const doorItem = (at: number, id = 'evt-1'): Record<string, AttributeValue> => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `EVT#${String(at).padStart(15, '0')}#${id}` },
  type: { S: 'door' },
});

// 2026-W38 is Monday 14 Sep to Sunday 20 Sep; "now" is after it ends.
const AFTER_W38 = Date.UTC(2026, 8, 21, 20);
const WEEK = 7 * 86_400_000;
const W38_START = Date.UTC(2026, 8, 14);
/** `n` door events on the Wednesday of the week `weeksAgo` weeks before W38. */
const doorsInWeek = (weeksAgo: number, n: number): Record<string, AttributeValue>[] =>
  Array.from({ length: n }, (_, i) => doorItem(W38_START - weeksAgo * WEEK + 2 * 86_400_000 + 9 * 3_600_000 + i * 60_000, `w${weeksAgo}-${i}`));

const deps = (over: Partial<NarratorDeps>): NarratorDeps => ({
  loadEvents: async () => [],
  firstEventAt: async () => undefined,
  writeNarrative: async () => 'A quiet week.',
  now: () => AFTER_W38,
  timeZone: 'Europe/London',
  ...over,
});

describe('computeWeekNarrative', () => {
  it('loads the week by its ISO range and shows the model counted facts, never raw events', async () => {
    const loadEvents = vi.fn(async () => [doorItem(Date.UTC(2026, 8, 16, 9), 'a'), doorItem(Date.UTC(2026, 8, 16, 10), 'b')]);
    const writeNarrative = vi.fn<NarratorDeps['writeNarrative']>(async () => 'Someone came to the door twice, on Wednesday morning.');

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ loadEvents, writeNarrative }));

    // The week itself, and the six before it that a usual week is drawn from.
    expect(loadEvents).toHaveBeenCalledWith({ startMs: Date.UTC(2026, 8, 14) - 6 * WEEK, endMs: Date.UTC(2026, 8, 21) });
    expect(writeNarrative.mock.calls[0]![0]).toEqual([
      'This is the whole week: Monday to Sunday.',
      'Someone came to the front door 2 times.',
      'Wednesday morning: 2 times at the front door.',
      'There is not enough history yet to know what a usual week is.',
    ]);
    expect(result.timeline).toHaveLength(2);
    expect(result.text).toBe('Someone came to the door twice, on Wednesday morning.');
    expect(result.textSource).toBe('model');
  });

  it('carries the household, week and generation time straight through', async () => {
    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ now: () => 1789999999999 }));

    expect(result.householdId).toBe('hh-1');
    expect(result.isoWeek).toBe('2026-W38');
    expect(result.generatedAt).toBe(1789999999999);
  });

  it('asks again, saying why, when the model uses a number it was never given', async () => {
    const writeNarrative = vi
      .fn<NarratorDeps['writeNarrative']>()
      .mockResolvedValueOnce('Six people came by.')
      .mockResolvedValueOnce('A quiet week.');

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ writeNarrative }));

    expect(writeNarrative).toHaveBeenCalledTimes(2);
    expect(writeNarrative.mock.calls[1]![1]).toMatch(/Six/);
    expect(result.text).toBe('A quiet week.');
    expect(result.textSource).toBe('model');
  });

  it('writes the week from the facts alone when the model fails the check twice', async () => {
    const writeNarrative = vi.fn(async () => 'It was a flurry of activity, with nine visitors.');

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ writeNarrative }));

    expect(writeNarrative).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('A quiet week. Nobody came to the front door.');
    expect(result.textSource).toBe('facts');
  });

  it('still writes an honest week when the model cannot be reached at all', async () => {
    const writeNarrative = vi.fn(async () => {
      throw new Error('AccessDeniedException');
    });

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ writeNarrative }));

    expect(result.text).toBe('A quiet week. Nobody came to the front door.');
    expect(result.textSource).toBe('facts');
  });

  it('reports no baseline for a household with no history — Principle 11 forbids inventing one', async () => {
    expect((await computeWeekNarrative('hh-1', '2026-W38', deps({}))).deltas).toEqual([
      { metric: 'door', label: 'the front door', thisWeek: 0, baseline: 0, zScore: 0, baselineWeeks: 0 },
    ]);
  });

  it('keeps the weeks before out of this week\'s timeline, and counts this week against them', async () => {
    const loadEvents = async () => [...doorsInWeek(0, 4), ...doorsInWeek(1, 3), ...doorsInWeek(2, 5), ...doorsInWeek(3, 4)];
    const writeNarrative = vi.fn<NarratorDeps['writeNarrative']>(async () => 'Someone came to the door four times, about the usual. Nothing unusual this week.');

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ loadEvents, writeNarrative, firstEventAt: async () => W38_START - 3 * WEEK }));

    expect(result.timeline).toHaveLength(4);
    expect(result.deltas).toEqual([
      { metric: 'door', label: 'the front door', thisWeek: 4, lastWeek: 3, baseline: 4, zScore: 0, baselineWeeks: 3, verdict: 'usual' },
    ]);
    expect(writeNarrative.mock.calls[0]![0].slice(3)).toEqual([
      'Last week: 3 times at the front door.',
      'In a usual week: about 4 times at the front door.',
      'The front door this week: about the usual.',
      'Nothing unusual this week.',
    ]);
    expect(result.text).toBe('Someone came to the door four times, about the usual. Nothing unusual this week.');
    expect(result.textSource).toBe('model');
  });

  it('asks again, saying why, when the model calls a week usual on no history', async () => {
    const writeNarrative = vi
      .fn<NarratorDeps['writeNarrative']>()
      .mockResolvedValueOnce('A quiet week, nothing unusual.')
      .mockResolvedValueOnce('A quiet week.');

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ writeNarrative }));

    expect(writeNarrative.mock.calls[1]![1]).toMatch(/"unusual".*facts do not support/);
    expect(result.text).toBe('A quiet week.');
  });

  it('says what the baseline found even when the model cannot be reached', async () => {
    const loadEvents = async () => [...doorsInWeek(0, 4), ...doorsInWeek(1, 3), ...doorsInWeek(2, 5), ...doorsInWeek(3, 4)];
    const writeNarrative = async () => {
      throw new Error('AccessDeniedException');
    };

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ loadEvents, writeNarrative, firstEventAt: async () => W38_START - 3 * WEEK }));

    expect(result.text).toBe('Someone came to the front door four times this week, on Wednesday morning. Nothing unusual this week.');
    expect(result.textSource).toBe('facts');
  });

  it('leaves residentSeenAt unset — INV-7: no family surface may read this until the resident has seen it on their own television', async () => {
    expect((await computeWeekNarrative('hh-1', '2026-W38', deps({}))).residentSeenAt).toBeUndefined();
  });

  it('filters unrecognised raw items out of the timeline before they ever reach the model', async () => {
    const cardShown: Record<string, AttributeValue> = {
      pk: { S: 'HH#hh-1' },
      sk: { S: 'EVT#001789455093305#evt-2' },
      type: { S: 'card_shown' },
      cardId: { S: 'door-1' },
    };

    const result = await computeWeekNarrative('hh-1', '2026-W38', deps({ loadEvents: async () => [cardShown] }));

    expect(result.timeline).toEqual([]);
  });
});

describe('factsWeekNarrative — a week written with no model at all', () => {
  it('writes the same week the Narrator would fall back to, from the same events', () => {
    const items = [...doorsInWeek(0, 4), ...doorsInWeek(1, 4), ...doorsInWeek(2, 4), ...doorsInWeek(3, 4)];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const week = factsWeekNarrative('hh-1', '2026-W38', items, { now: AFTER_W38, timeZone: 'Europe/London', observedSince: W38_START - 3 * WEEK });

    expect(week).toMatchObject({ householdId: 'hh-1', isoWeek: '2026-W38', textSource: 'facts', generatedAt: AFTER_W38 });
    expect(week.timeline).toHaveLength(4);
    expect(week.deltas[0]).toMatchObject({ metric: 'door', thisWeek: 4, lastWeek: 4, baselineWeeks: 3, verdict: 'usual' });
    expect(week.text).toContain('Nothing unusual this week.');
    expect(week.residentSeenAt).toBeUndefined();
    // Not a model that failed: there was never one to fail.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
