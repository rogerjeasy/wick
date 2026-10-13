import { describe, it, expect } from 'vitest';
import type { WeekNarrative } from '@wick/contracts';
import { buildWeekCard, familyNameForWeekCard } from '../weekCard.js';

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

  it('offers OK first, and focused — acknowledging is what releases the week (INV-7) — then "What Sarah sees" (trust promise 2)', () => {
    const queued = buildWeekCard(narrative, 'corr-1', 2000, 'Sarah');
    expect(queued.card.actions).toEqual([
      { id: 'seen', label: 'OK', kind: 'primary' },
      { id: 'sharing', label: 'What Sarah sees', kind: 'secondary' },
    ]);
  });

  it('says "your family" when the household has not named anyone', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).card.actions[1]).toMatchObject({ label: 'What your family sees' });
  });

  it('never expires — Principle 9, no time limits, and DEFERRED cards carry no expiresAt', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).expiresAt).toBeUndefined();
  });

  it('carries the household id through from the narrative', () => {
    expect(buildWeekCard(narrative, 'corr-1', 2000).card.householdId).toBe('hh-1');
  });
});

describe('familyNameForWeekCard — who "What … sees" names', () => {
  it('is the first name of the one person she has allowed', () => {
    expect(familyNameForWeekCard(['Sarah Hughes'])).toBe('Sarah');
    expect(familyNameForWeekCard(['Guest'])).toBe('Guest');
  });

  it('is nobody by name when several can see it, when nobody can yet, or when the name would not fit the button', () => {
    expect(familyNameForWeekCard(['Sarah', 'Tom'])).toBeUndefined();
    expect(familyNameForWeekCard([])).toBeUndefined();
    expect(familyNameForWeekCard(['Bartholomew-James Smith'])).toBeUndefined();
  });
});
