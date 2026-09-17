import { describe, expect, it } from 'vitest';
import { buildMessageCard } from '../send_note_to_tv.js';

describe('buildMessageCard', () => {
  it('builds a MESSAGE card with three static suggested replies', () => {
    const card = buildMessageCard({
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      message: 'Just checking in — call me when you get a chance!',
      now: 1700000000000,
    });

    expect(card.card).toMatchObject({
      type: 'MESSAGE',
      householdId: 'hh-1',
      correlationId: 'corr-1',
      fromName: 'Alex',
      transcript: 'Just checking in — call me when you get a chance!',
    });
    expect(card.card.type === 'MESSAGE' && card.card.suggestedReplies).toHaveLength(3);
    expect(card.urgency).toBe('DEFERRED');
    expect(card.shownCount).toBe(0);
  });
});
