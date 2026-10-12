import { describe, expect, it } from 'vitest';
import { TELL_ACTIONS, differenceIdFromTellCardId, tellAnswerOf, tellCardId } from '../tell.js';

describe('tell card ids', () => {
  it('name the difference they ask about, and give it back', () => {
    const cardId = tellCardId('missed_visit-maria-2026-10-09');

    expect(cardId).toBe('tell-missed_visit-maria-2026-10-09');
    expect(differenceIdFromTellCardId(cardId)).toBe('missed_visit-maria-2026-10-09');
  });

  it('are nothing for any other card', () => {
    expect(differenceIdFromTellCardId('door-abc')).toBeUndefined();
    expect(differenceIdFromTellCardId('tell-')).toBeUndefined();
    expect(differenceIdFromTellCardId('note-tell-x')).toBeUndefined();
  });
});

describe('tellAnswerOf — what a press on the card means', () => {
  it('is "tell" or "keep" for the card’s two buttons, and nothing for any other press', () => {
    expect(tellAnswerOf(TELL_ACTIONS.tell)).toBe('tell');
    expect(tellAnswerOf(TELL_ACTIONS.keep)).toBe('keep');
    expect(tellAnswerOf('dismiss')).toBeUndefined();
    expect(tellAnswerOf(undefined)).toBeUndefined();
  });
});
