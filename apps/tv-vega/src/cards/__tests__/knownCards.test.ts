import { describe, expect, it } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { KNOWN_CARD_TYPES, isKnownCard } from '../knownCards.js';

const queued = (type: string, over: Record<string, unknown> = {}): QueuedCard =>
  ({
    id: 'c1',
    urgency: 'DEFERRED',
    card: { type, id: 'c1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] },
    queuedAt: 0,
    shownCount: 0,
    ...over,
  }) as unknown as QueuedCard;

describe('isKnownCard — a card this build can draw', () => {
  it('knows every card it has a view for, the question about her language among them', () => {
    expect([...KNOWN_CARD_TYPES].sort()).toEqual(['CIRCLE', 'DOOR', 'LANGUAGE', 'LIGHT', 'MESSAGE', 'PHOTO', 'REACH', 'SHARING', 'TELL', 'VISIT', 'WATCH', 'WEEK']);
    for (const type of KNOWN_CARD_TYPES) expect(isKnownCard(queued(type)), type).toBe(true);
  });

  it('does not know a card the server learnt after this build was made', () => {
    expect(isKnownCard(queued('SOMETHING_NEW'))).toBe(false);
    // Not a property of every object, either.
    expect(isKnownCard(queued('constructor'))).toBe(false);
    expect(isKnownCard(queued('toString'))).toBe(false);
  });

  it('does not know something that is not a card at all', () => {
    for (const not of [null, undefined, 'card', 7, {}, { id: 'c1' }, { id: 'c1', card: null }, { id: 'c1', card: { type: 7 } }, { id: 7, card: { type: 'DOOR' } }]) {
      expect(isKnownCard(not)).toBe(false);
    }
  });
  // That the renderer draws each of these, and nothing for any other, is drawn in CardRenderer.test.tsx.
});
