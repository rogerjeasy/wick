import { describe, it, expect } from 'vitest';
import type { DayCard, MessageCard, QueuedCard } from '@wick/contracts';
import { buildAlreadyShown, pickPendingFamilyMessage } from '../lambda.js';

function messageCard(over: Partial<QueuedCard> = {}, cardOver: Partial<MessageCard> = {}): QueuedCard {
  const card: MessageCard = {
    type: 'MESSAGE',
    id: 'msg-1',
    householdId: 'hh-1',
    correlationId: 'c1',
    createdAt: 1000,
    actions: [],
    fromName: 'Sarah',
    suggestedReplies: [],
    ...cardOver,
  };
  return { id: card.id, urgency: 'DEFERRED', card, queuedAt: 1000, shownCount: 0, ...over };
}

describe('pickPendingFamilyMessage', () => {
  it('picks an unshown MESSAGE card', () => {
    expect(pickPendingFamilyMessage([messageCard()])).toEqual({ fromName: 'Sarah' });
  });

  it('ignores a MESSAGE card already shown', () => {
    expect(pickPendingFamilyMessage([messageCard({ shownCount: 1 })])).toBeUndefined();
  });

  it('ignores non-MESSAGE cards', () => {
    const door: QueuedCard = {
      id: 'd1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'd1', householdId: 'hh-1', correlationId: 'c1', createdAt: 1000, actions: [], line: 'x' },
      queuedAt: 1000,
      shownCount: 0,
    };
    expect(pickPendingFamilyMessage([door])).toBeUndefined();
  });

  it('picks the most recently queued when several are pending', () => {
    const older = messageCard({ queuedAt: 1000 }, { id: 'older', fromName: 'Old' });
    const newer = messageCard({ id: 'newer', queuedAt: 2000 }, { id: 'newer', fromName: 'New' });
    expect(pickPendingFamilyMessage([older, newer])).toEqual({ fromName: 'New' });
  });

  it('returns undefined for an empty list', () => {
    expect(pickPendingFamilyMessage([])).toBeUndefined();
  });
});

describe('buildAlreadyShown', () => {
  function dayCard(over: Partial<DayCard> = {}): DayCard {
    return {
      type: 'DAY',
      id: 'day-1',
      householdId: 'hh-1',
      correlationId: 'c1',
      createdAt: 1000,
      actions: [],
      greeting: 'hi',
      items: [{ text: 'x', factId: 'fact-1' }],
      ...over,
    };
  }

  it('maps each item factId to its card\'s createdAt', () => {
    const map = buildAlreadyShown([dayCard()]);
    expect(map.get('fact-1')).toEqual({ shownAt: 1000 });
  });

  it('keeps the most recent showing when a fact appears in more than one card', () => {
    const map = buildAlreadyShown([dayCard({ id: 'a', createdAt: 1000 }), dayCard({ id: 'b', createdAt: 2000 })]);
    expect(map.get('fact-1')).toEqual({ shownAt: 2000 });
  });

  it('returns an empty map for no cards', () => {
    expect(buildAlreadyShown([]).size).toBe(0);
  });
});
