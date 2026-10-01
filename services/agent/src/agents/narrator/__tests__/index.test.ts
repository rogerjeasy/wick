import { describe, it, expect, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { computeWeekNarrative, type NarratorDeps } from '../index.js';

const doorItem = (at: number, id = 'evt-1'): Record<string, AttributeValue> => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `EVT#${String(at).padStart(15, '0')}#${id}` },
  type: { S: 'door' },
});

// 2026-W38 is Monday 14 Sep to Sunday 20 Sep; "now" is after it ends.
const AFTER_W38 = Date.UTC(2026, 8, 21, 20);
const deps = (over: Partial<NarratorDeps>): NarratorDeps => ({
  loadEvents: async () => [],
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

    expect(loadEvents).toHaveBeenCalledWith({ startMs: Date.UTC(2026, 8, 14), endMs: Date.UTC(2026, 8, 21) });
    expect(writeNarrative.mock.calls[0]![0]).toEqual([
      'This is the whole week: Monday to Sunday.',
      'Someone came to the front door 2 times.',
      'Wednesday morning: 2 times at the front door.',
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

  it('reports no deltas — there is no Rhythm baseline yet, and Principle 11 forbids inventing one', async () => {
    expect((await computeWeekNarrative('hh-1', '2026-W38', deps({}))).deltas).toEqual([]);
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
