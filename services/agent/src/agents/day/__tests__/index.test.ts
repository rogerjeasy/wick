import { describe, it, expect } from 'vitest';
import type { Commitment, Fact } from '@wick/contracts';
import { buildDayCard, selectDayItems, type DaySelectionInput } from '../index.js';

const NOW = Date.UTC(2026, 8, 15, 17, 22); // Tuesday, matches the demo narrative's 17:22 break.

function commitment(over: Partial<Commitment> = {}): Commitment {
  return {
    id: 'commitment-1',
    householdId: 'hh-1',
    class: 'COMMITMENT',
    content: 'the surgery rang about Thursday',
    sourceIds: ['conv-1'],
    observedAt: NOW - 60_000,
    confidence: 0.8,
    dueAt: NOW + 2 * 24 * 60 * 60 * 1000,
    ...over,
  };
}

function healthFact(over: Partial<Fact> = {}): Fact {
  return {
    id: 'fact-knee',
    householdId: 'hh-1',
    class: 'HEALTH',
    content: 'mentioned her knee again',
    sourceIds: ['conv-2'],
    observedAt: NOW - 30_000,
    confidence: 0.7,
    ...over,
  };
}

function baseInput(over: Partial<DaySelectionInput> = {}): DaySelectionInput {
  return {
    commitments: [],
    healthFactsThisWeek: [],
    healthFactsPriorWeek: [],
    alreadyShown: new Map(),
    now: NOW,
    ...over,
  };
}

describe('selectDayItems — rubric 1: commitments', () => {
  it('surfaces a commitment due within the near-deadline window', () => {
    const items = selectDayItems(baseInput({ commitments: [commitment()] }));
    expect(items).toEqual([
      expect.objectContaining({ factId: 'commitment-1', source: 'COMMITMENT', text: 'the surgery rang about Thursday' }),
    ]);
  });

  it('does not surface a commitment far past the near-deadline window', () => {
    const items = selectDayItems(
      baseInput({ commitments: [commitment({ dueAt: NOW + 30 * 24 * 60 * 60 * 1000 })] }),
    );
    expect(items).toEqual([]);
  });

  it('does not surface a commitment that has already passed', () => {
    const items = selectDayItems(baseInput({ commitments: [commitment({ dueAt: NOW - 1000 })] }));
    expect(items).toEqual([]);
  });

  it('picks the soonest of several near-deadline commitments', () => {
    const soon = commitment({ id: 'soon', dueAt: NOW + 1000 });
    const later = commitment({ id: 'later', dueAt: NOW + 3 * 24 * 60 * 60 * 1000 });
    const items = selectDayItems(baseInput({ commitments: [later, soon] }));
    expect(items[0]?.factId).toBe('soon');
  });

  it('does not repeat a commitment shown within the last 7 days at the same deadline', () => {
    const c = commitment();
    const alreadyShown = new Map<string, { shownAt: number; dueAt?: number }>([
      [c.id, { shownAt: NOW - 24 * 60 * 60 * 1000, ...(c.dueAt !== undefined ? { dueAt: c.dueAt } : {}) }],
    ]);
    const items = selectDayItems(baseInput({ commitments: [c], alreadyShown }));
    expect(items).toEqual([]);
  });

  it('resurfaces a commitment whose deadline moved, even if shown recently', () => {
    const c = commitment({ dueAt: NOW + 24 * 60 * 60 * 1000 });
    const alreadyShown = new Map([[c.id, { shownAt: NOW - 24 * 60 * 60 * 1000, dueAt: NOW + 3 * 24 * 60 * 60 * 1000 }]]);
    const items = selectDayItems(baseInput({ commitments: [c], alreadyShown }));
    expect(items).toHaveLength(1);
  });

  it('resurfaces a commitment shown more than 7 days ago', () => {
    const c = commitment();
    const alreadyShown = new Map<string, { shownAt: number; dueAt?: number }>([
      [c.id, { shownAt: NOW - 8 * 24 * 60 * 60 * 1000, ...(c.dueAt !== undefined ? { dueAt: c.dueAt } : {}) }],
    ]);
    const items = selectDayItems(baseInput({ commitments: [c], alreadyShown }));
    expect(items).toHaveLength(1);
  });
});

describe('selectDayItems — rubric 2: health pattern (frequency delta, never guessed)', () => {
  it('does not surface a single, one-off mention', () => {
    const items = selectDayItems(baseInput({ healthFactsThisWeek: [healthFact()] }));
    expect(items).toEqual([]);
  });

  it('surfaces a second mention this week when last week had fewer', () => {
    const items = selectDayItems(
      baseInput({
        healthFactsThisWeek: [healthFact({ id: 'a', observedAt: NOW - 1000 }), healthFact({ id: 'b', observedAt: NOW })],
        healthFactsPriorWeek: [healthFact({ id: 'c' })],
      }),
    );
    expect(items).toEqual([expect.objectContaining({ source: 'HEALTH_PATTERN' })]);
  });

  it('does not surface when frequency did not increase', () => {
    const items = selectDayItems(
      baseInput({
        healthFactsThisWeek: [healthFact({ id: 'a' }), healthFact({ id: 'b' })],
        healthFactsPriorWeek: [healthFact({ id: 'c' }), healthFact({ id: 'd' })],
      }),
    );
    expect(items).toEqual([]);
  });

  it('picks the most recent fact to carry the wording', () => {
    const older = healthFact({ id: 'older', observedAt: NOW - 10_000, content: 'knee, first mention' });
    const newer = healthFact({ id: 'newer', observedAt: NOW - 1_000, content: 'knee, second mention' });
    const items = selectDayItems(
      baseInput({ healthFactsThisWeek: [older, newer], healthFactsPriorWeek: [healthFact({ id: 'prior' })] }),
    );
    expect(items[0]?.text).toBe('knee, second mention');
  });
});

describe('selectDayItems — rubric 3: family', () => {
  it('surfaces a teaser, never the message content itself', () => {
    const items = selectDayItems(baseInput({ pendingFamilyMessage: { fromName: 'Sarah' } }));
    expect(items).toEqual([
      expect.objectContaining({ source: 'FAMILY', text: 'Sarah has sent you a message.' }),
    ]);
  });
});

describe('selectDayItems — hard rules', () => {
  it('never returns more than three items, in rubric priority order', () => {
    const items = selectDayItems(
      baseInput({
        commitments: [commitment()],
        healthFactsThisWeek: [healthFact({ id: 'a' }), healthFact({ id: 'b' })],
        healthFactsPriorWeek: [],
        pendingFamilyMessage: { fromName: 'Sarah' },
      }),
    );
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.source)).toEqual(['COMMITMENT', 'HEALTH_PATTERN', 'FAMILY']);
  });
});

describe('buildDayCard', () => {
  it('returns null for zero items — silence is the default state', () => {
    expect(buildDayCard({ items: [], householdId: 'hh-1', correlationId: 'c1', now: NOW, isoDay: '2026-09-15' })).toBeNull();
  });

  it('builds a DAY card with a dismiss-only action and the items carried through', () => {
    const items = selectDayItems(baseInput({ commitments: [commitment()] }));
    const card = buildDayCard({ items, householdId: 'hh-1', correlationId: 'c1', now: NOW, isoDay: '2026-09-15' });
    expect(card).toMatchObject({
      type: 'DAY',
      householdId: 'hh-1',
      correlationId: 'c1',
      items: [{ text: 'the surgery rang about Thursday', factId: 'commitment-1' }],
    });
    expect(card?.actions).toHaveLength(1);
  });

  it('derives a stable id from the same items on the same day (redelivery-safe, INV-6)', () => {
    const items = selectDayItems(baseInput({ commitments: [commitment()] }));
    const a = buildDayCard({ items, householdId: 'hh-1', correlationId: 'c1', now: NOW, isoDay: '2026-09-15' });
    const b = buildDayCard({ items, householdId: 'hh-1', correlationId: 'c2', now: NOW + 1000, isoDay: '2026-09-15' });
    expect(a?.id).toBe(b?.id);
  });
});
