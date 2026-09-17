import { describe, it, expect } from 'vitest';
import type { DoorCard } from '@wick/contracts';
import { doorDetailText } from '../doorDetail.js';

const base: DoorCard = {
  type: 'DOOR',
  id: 'door-1',
  householdId: 'hh-1',
  correlationId: 'corr-1',
  createdAt: 1,
  line: "Someone's at the front door.",
  actions: [],
};

describe('doorDetailText', () => {
  it('shows nothing when neither a description nor a match has arrived — Phase 1 stands', () => {
    expect(doorDetailText(base)).toBeUndefined();
  });

  it("prefers the vision model's real observation over a schedule guess — an observation beats an inference", () => {
    const card: DoorCard = {
      ...base,
      description: 'A man in a delivery uniform, holding a parcel.',
      match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.5 },
    };
    expect(doorDetailText(card)).toBe('A man in a delivery uniform, holding a parcel.');
  });

  it('falls back to the schedule match, available from Phase 1, before any description has arrived', () => {
    const card: DoorCard = {
      ...base,
      match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.5 },
    };
    expect(doorDetailText(card)).toBe('This looks like Maria — expected around now.');
  });

  it('never claims "expected" for a match that fell outside today\'s pattern', () => {
    const card: DoorCard = {
      ...base,
      match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: false, confidence: 0.5 },
    };
    expect(doorDetailText(card)).toBe('This looks like Maria.');
  });
});
