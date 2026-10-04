import { describe, it, expect } from 'vitest';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { QueuedCard, WeekNarrative } from '@wick/contracts';
import { householdsWithTelevision, narrateEveryHousehold, type EveryHouseholdDeps } from '../everyHousehold.js';

const doorItem = (householdId: string, at: number, id: string): Record<string, AttributeValue> => ({
  pk: { S: `HH#${householdId}` },
  sk: { S: `EVT#${String(at).padStart(15, '0')}#${id}` },
  type: { S: 'door' },
});

// 2026-W38 is Monday 14 Sep to Sunday 20 Sep; "now" is after it ends.
const AFTER_W38 = Date.UTC(2026, 8, 21, 20);

interface Run {
  readonly deps: EveryHouseholdDeps;
  readonly saved: WeekNarrative[];
  readonly cards: QueuedCard[];
}

function run(over: Partial<EveryHouseholdDeps>): Run {
  const saved: WeekNarrative[] = [];
  const cards: QueuedCard[] = [];
  return {
    saved,
    cards,
    deps: {
      listHouseholds: async () => [],
      loadEvents: async () => [],
      writeNarrative: async () => 'A quiet week.',
      saveNarrative: async (narrative) => { saved.push(narrative); },
      sendWeekCard: async (card) => { cards.push(card); },
      now: () => AFTER_W38,
      newCorrelationId: () => 'corr-1',
      timeZone: 'Europe/London',
      ...over,
    },
  };
}

describe('narrateEveryHousehold', () => {
  it('gives each household its own week, from its own events, on its own television', async () => {
    const events: Record<string, Record<string, AttributeValue>[]> = {
      'hh-a': [doorItem('hh-a', Date.UTC(2026, 8, 16, 9), 'a1'), doorItem('hh-a', Date.UTC(2026, 8, 16, 10), 'a2')],
      'hh-b': [],
    };
    const { deps, saved, cards } = run({
      listHouseholds: async () => ['hh-a', 'hh-b'],
      loadEvents: async (householdId) => events[householdId] ?? [],
    });

    const result = await narrateEveryHousehold('2026-W38', deps);

    expect(saved.map((n) => [n.householdId, n.isoWeek, n.timeline.length])).toEqual([
      ['hh-a', '2026-W38', 2],
      ['hh-b', '2026-W38', 0],
    ]);
    expect(cards.map((c) => [c.card.householdId, c.id])).toEqual([
      ['hh-a', 'week-2026-W38'],
      ['hh-b', 'week-2026-W38'],
    ]);
    expect(result).toEqual({ written: ['hh-a', 'hh-b'], failed: [] });
  });

  it('still gives the next household its week when one household\'s week cannot be stored', async () => {
    const saved: string[] = [];
    const { deps, cards } = run({
      listHouseholds: async () => ['hh-a', 'hh-b'],
      saveNarrative: async (narrative) => {
        if (narrative.householdId === 'hh-a') throw new Error('ProvisionedThroughputExceededException');
        saved.push(narrative.householdId);
      },
    });

    const result = await narrateEveryHousehold('2026-W38', deps);

    expect(saved).toEqual(['hh-b']);
    // No card for a week that was never stored: its OK button would release nothing.
    expect(cards.map((c) => c.card.householdId)).toEqual(['hh-b']);
    expect(result).toEqual({ written: ['hh-b'], failed: ['hh-a'] });
  });

  it('counts a household as failed when its television cannot be reached, and carries on', async () => {
    const { deps, saved } = run({
      listHouseholds: async () => ['hh-a', 'hh-b'],
      sendWeekCard: async (card) => {
        if (card.card.householdId === 'hh-a') throw new Error('InternalServerError');
      },
    });

    const result = await narrateEveryHousehold('2026-W38', deps);

    expect(saved.map((n) => n.householdId)).toEqual(['hh-a', 'hh-b']);
    expect(result).toEqual({ written: ['hh-b'], failed: ['hh-a'] });
  });
});

describe('householdsWithTelevision', () => {
  const row = (pk: string, sk: string): Record<string, AttributeValue> => ({ pk: { S: pk }, sk: { S: sk } });

  it('names each household that has a paired television, once', () => {
    expect(householdsWithTelevision([
      row('HH#hh-a', 'DEV#wick-tv'),
      row('HH#hh-a', 'DEV#ops-console-1'),
      row('HH#hh-b', 'DEV#living-room'),
    ])).toEqual(['hh-a', 'hh-b']);
  });

  it('leaves out a household with no television: there is nowhere for the resident to see the week first', () => {
    expect(householdsWithTelevision([
      row('HH#hh-c', 'META'),
      row('HH#hh-c', 'MEM#user-1'),
      // Which household a television belongs to (device-owner.mjs) — a device, not a household.
      row('DEV#wick-tv', 'META'),
    ])).toEqual([]);
  });
});
