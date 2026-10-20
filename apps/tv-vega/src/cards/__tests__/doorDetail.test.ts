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
    expect(doorDetailText(card)).toBe('Maria is expected around now.');
  });

  it('never claims "expected" for a match that fell outside today\'s pattern', () => {
    const card: DoorCard = {
      ...base,
      match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: false, confidence: 0.5 },
    };
    expect(doorDetailText(card)).toBe('Maria often comes around this time.');
  });
});

describe('doorDetailText — in the language she chose', () => {
  const door = (over: Partial<DoorCard>): DoorCard => ({
    type: 'DOOR', id: 'door-1', householdId: 'h', correlationId: 'c', createdAt: 0, actions: [], line: 'Alguien está en la puerta.', ...over,
  });

  it('says who is due in Spanish, with no word that has to agree with the name', () => {
    expect(doorDetailText(door({ match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.5 } }), 'es')).toBe('Se espera a Maria sobre esta hora.');
    expect(doorDetailText(door({ match: { personId: 'tom', name: 'Tom', basis: 'schedule', expectedToday: false, confidence: 0.5 } }), 'es')).toBe('Tom suele venir a esta hora.');
  });

  it('says the description as the server wrote it: that came in her language already', () => {
    const described = door({ description: 'Un mensajero con una chaqueta azul.', match: { personId: 'maria', name: 'Maria', basis: 'schedule', expectedToday: true, confidence: 0.5 } });

    expect(doorDetailText(described, 'es')).toBe('Un mensajero con una chaqueta azul.');
  });

  it('still says nothing when nothing is known', () => {
    expect(doorDetailText(door({}), 'es')).toBeUndefined();
  });
});
