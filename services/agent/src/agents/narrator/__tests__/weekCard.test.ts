import { describe, it, expect } from 'vitest';
import type { WeekNarrative } from '@wick/contracts';
import { buildWeekCard } from '../weekCard.js';

const narrative: WeekNarrative = {
  householdId: 'hh-1',
  isoWeek: '2026-W38',
  text: 'A quiet week. Maria visited as usual.',
  deltas: [],
  timeline: [],
  generatedAt: 1789455093305,
};

describe('buildWeekCard', () => {
  it('derives the card id deterministically from the isoWeek, not randomly', () => {
    const queued = buildWeekCard(narrative, 'corr-1', 2000);
    expect(queued.id).toBe('week-2026-W38');
    expect(queued.card.id).toBe('week-2026-W38');
  });

  it('is DEFERRED, not DOOR — a weekly narrative is never urgent (INV-5)', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).urgency).toBe('DEFERRED');
  });

  it('carries the narrative text as the card body', () => {
    const queued = buildWeekCard(narrative, 'corr-1', 2000);
    expect(queued.card.type).toBe('WEEK');
    if (queued.card.type !== 'WEEK') throw new Error('unreachable');
    expect(queued.card.text).toBe('A quiet week. Maria visited as usual.');
    expect(queued.card.isoWeek).toBe('2026-W38');
  });

  it('offers exactly one action — acknowledging is the whole interaction', () => {
    const queued = buildWeekCard(narrative, 'corr-1', 2000);
    expect(queued.card.actions).toEqual([{ id: 'seen', label: 'OK', kind: 'primary' }]);
  });

  it('never expires — Principle 9, no time limits, and DEFERRED cards carry no expiresAt', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).expiresAt).toBeUndefined();
  });

  it('carries the household id through from the narrative', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).card.householdId).toBe('hh-1');
  });
});
