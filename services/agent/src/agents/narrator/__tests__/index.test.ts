import { describe, it, expect, vi } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { TimelineEntry } from '@wick/contracts';
import { computeWeekNarrative } from '../index.js';

const doorItem = (at: number): Record<string, AttributeValue> => ({
  pk: { S: 'HH#hh-1' },
  sk: { S: `EVT#${String(at).padStart(15, '0')}#evt-1` },
  type: { S: 'door' },
});

describe('computeWeekNarrative', () => {
  it('loads the week by its ISO range and hands the mapped timeline to the model', async () => {
    const loadEvents = vi.fn(async () => [doorItem(1789455093305)]);
    const writeNarrative = vi.fn(async (_entries: readonly TimelineEntry[]) => 'A quiet week.');

    await computeWeekNarrative('hh-1', '2026-W38', {
      loadEvents,
      writeNarrative,
      now: () => 1789999999999,
    });

    expect(loadEvents).toHaveBeenCalledWith({ startMs: Date.UTC(2026, 8, 14), endMs: Date.UTC(2026, 8, 21) });
    const passedEntries = writeNarrative.mock.calls[0]![0]!;
    expect(passedEntries).toHaveLength(1);
    expect(passedEntries[0]).toMatchObject({ kind: 'door' });
  });

  it('carries the model text and the household/week straight through', async () => {
    const result = await computeWeekNarrative('hh-1', '2026-W38', {
      loadEvents: async () => [],
      writeNarrative: async () => 'A quiet week. Nothing unusual to report.',
      now: () => 1789999999999,
    });

    expect(result.householdId).toBe('hh-1');
    expect(result.isoWeek).toBe('2026-W38');
    expect(result.text).toBe('A quiet week. Nothing unusual to report.');
    expect(result.generatedAt).toBe(1789999999999);
  });

  it('reports no deltas — there is no Rhythm baseline yet, and Principle 11 forbids inventing one', async () => {
    const result = await computeWeekNarrative('hh-1', '2026-W38', {
      loadEvents: async () => [],
      writeNarrative: async () => 'A quiet week.',
      now: () => 1,
    });
    expect(result.deltas).toEqual([]);
  });

  it('leaves residentSeenAt unset — INV-7: no family surface may read this until the resident has seen it on their own television', async () => {
    const result = await computeWeekNarrative('hh-1', '2026-W38', {
      loadEvents: async () => [],
      writeNarrative: async () => 'A quiet week.',
      now: () => 1,
    });
    expect(result.residentSeenAt).toBeUndefined();
  });

  it('filters unrecognised raw items out of the timeline before they ever reach the model', async () => {
    const cardShown: Record<string, AttributeValue> = {
      pk: { S: 'HH#hh-1' },
      sk: { S: 'EVT#001789455093305#evt-2' },
      type: { S: 'card_shown' },
      cardId: { S: 'door-1' },
    };
    const writeNarrative = vi.fn(async () => 'A quiet week.');

    await computeWeekNarrative('hh-1', '2026-W38', {
      loadEvents: async () => [cardShown],
      writeNarrative,
      now: () => 1,
    });

    expect(writeNarrative).toHaveBeenCalledWith([]);
  });
});
