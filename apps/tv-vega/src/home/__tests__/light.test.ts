import { describe, expect, it } from 'vitest';
import type { Card, QueuedCard } from '@wick/contracts';
import { LIGHT_ANSWER_WAIT_MS, answersHerPress, lightLabel, lookedInLine, unaskedLightCards } from '../light.js';

/** Monday 12 October 2026, 10:30 by the television's own clock. */
const at = (hour: number, minute = 0, day = 12): number => new Date(2026, 9, day, hour, minute).getTime();
const NOW = at(10, 30);

describe('lightLabel — the button on the home screen', () => {
  it('says how her light stands, in two words', () => {
    expect(lightLabel({ light: 'on' })).toBe('Light on');
    expect(lightLabel({ light: 'out' })).toBe('Light out');
  });

  it('is nothing when there is no light for anyone to see', () => {
    expect(lightLabel({})).toBeUndefined();
    expect(lightLabel({ lookedIn: { name: 'Sarah', at: NOW, line: 'Sarah looked in this morning.' } })).toBeUndefined();
  });
});

describe('lookedInLine — who looked in', () => {
  const look = (when: number, line = 'Sarah looked in this morning.') => ({ lookedIn: { name: 'Sarah', at: when, line } });

  it('says the sentence the server wrote, as it stands: the server knows what time it is where the house is', () => {
    expect(lookedInLine(look(at(8, 15)), NOW)).toBe('Sarah looked in this morning.');
    expect(lookedInLine(look(at(14), 'Tom looked in this afternoon.'), at(15))).toBe('Tom looked in this afternoon.');
  });

  it('stops saying it when the day is over, and says nothing of nobody', () => {
    expect(lookedInLine(look(at(20, 0, 11)), NOW)).toBeUndefined();
    expect(lookedInLine({ light: 'on' }, NOW)).toBeUndefined();
  });
});

describe('unaskedLightCards — the Light card is an answer, never something owed', () => {
  const base = { householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [] } as const;
  const queued = (card: Card): QueuedCard => ({ id: card.id, urgency: 'DEFERRED', card, queuedAt: 0, shownCount: 0 });
  const light = queued({ ...base, id: 'light', type: 'LIGHT', headline: 'Your light is on.', detail: 'd' });
  const note = queued({ ...base, id: 'note-1', type: 'MESSAGE', fromName: 'Sarah', suggestedReplies: [] });

  it('is kept while it is the card she asked to see', () => {
    expect(unaskedLightCards([note, light], 'light')).toEqual([]);
  });

  it('is put away when it is found without her having asked — left from a launch that was cut short', () => {
    expect(unaskedLightCards([note, light], null)).toEqual(['light']);
    expect(unaskedLightCards([note, light], 'note-1')).toEqual(['light']);
    expect(unaskedLightCards([note], null)).toEqual([]);
  });
});

describe('answersHerPress — the Light card that comes after she asked for it', () => {
  it('is hers to see when it arrives soon after the press', () => {
    expect(answersHerPress(NOW, NOW + 1_500)).toBe(true);
    expect(answersHerPress(NOW, NOW + LIGHT_ANSWER_WAIT_MS - 1)).toBe(true);
  });

  it('is not when she never pressed, or it took so long she has moved on', () => {
    expect(answersHerPress(null, NOW)).toBe(false);
    expect(answersHerPress(NOW, NOW + LIGHT_ANSWER_WAIT_MS)).toBe(false);
  });
});
