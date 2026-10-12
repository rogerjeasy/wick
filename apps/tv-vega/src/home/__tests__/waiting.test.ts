import { describe, expect, it } from 'vitest';
import type { Card, QueuedCard } from '@wick/contracts';
import { waitingLine } from '../waiting.js';

const base = { id: 'c1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [] } as const;
const queued = (card: Card): QueuedCard => ({ id: card.id, urgency: 'DEFERRED', card, queuedAt: 0, shownCount: 2 });

describe('waitingLine — what the home screen says is waiting', () => {
  it('names who a note is from', () => {
    expect(waitingLine(queued({ ...base, type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: [] }))).toBe('A note from Sarah is waiting.');
  });

  it('says the week is ready', () => {
    expect(waitingLine(queued({ ...base, type: 'WEEK', isoWeek: '2026-W41', text: 'A quiet week.' }))).toBe('Your week is ready to read.');
  });

  it('names who would like to join', () => {
    const circle: Card = { ...base, type: 'CIRCLE', personName: 'Tom', role: 'family', headline: 'h', detail: 'd' } as Card;

    expect(waitingLine(queued(circle))).toBe('Tom would like to join your family circle.');
  });

  it('says there is a question waiting, without saying what it is about', () => {
    const tell: Card = { ...base, type: 'TELL', headline: 'Shall I tell Sarah?', detail: 'Maria usually comes on Friday mornings.' };

    expect(waitingLine(queued(tell))).toBe('Wick has a question for you.');
  });
});
