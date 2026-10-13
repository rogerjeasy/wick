import { describe, it, expect } from 'vitest';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { announcesRetirement, buildCardActionEntry, buildCardRetiredEntry, shouldPublish } from '../card-action-event.mjs';

describe('card-action-event — presses the agent plane has to carry out', () => {
  it('publishes the hallway chime, and nothing the device finishes on its own', () => {
    expect(shouldPublish('hallway_chime')).toBe(true);
    expect(shouldPublish('dismiss')).toBe(false);
    expect(shouldPublish('seen')).toBe(false);
    // Watch live goes over HTTPS to /live/sessions, not through the bus.
    expect(shouldPublish('watch_live')).toBe(false);
  });

  it('builds a wick.device / card.action entry with ids only — never card content', () => {
    const entry = buildCardActionEntry({ busName: 'wick', householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: 5 });
    expect(entry).toEqual({
      EventBusName: 'wick',
      Source: 'wick.device',
      DetailType: 'card.action',
      Detail: JSON.stringify({ householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: 5 }),
    });
  });
});

describe('shouldPublish — asking the family to look', () => {
  it('hands "ask_family" to the agent plane: who is asked, and telling the resident, are decided there', () => {
    expect(shouldPublish('ask_family')).toBe(true);
  });
});

describe('a card finished on one television', () => {
  it('is announced, so the home’s other televisions put it away: a note answered, a week read, a door card dismissed', () => {
    expect(announcesRetirement('reply_0')).toBe(true);
    expect(announcesRetirement('seen')).toBe(true);
    expect(announcesRetirement('dismiss')).toBe(true);
  });

  it('is not announced for a press that leaves the card on screen', () => {
    expect(announcesRetirement('hallway_chime')).toBe(false);
    expect(announcesRetirement('watch_live')).toBe(false);
    expect(announcesRetirement('sharing')).toBe(false);
  });

  it('is not announced twice: the agent plane already hears the answer to "Shall I tell ...?" and withdraws that card itself', () => {
    expect(announcesRetirement('tell_family')).toBe(false);
    expect(announcesRetirement('keep_private')).toBe(false);
  });

  it('builds a wick.device / card.retired entry with ids only', () => {
    expect(buildCardRetiredEntry({ busName: 'wick', householdId: 'margaret', deviceId: 'wick-tv', cardId: 'note-abc', at: 5 })).toEqual({
      EventBusName: 'wick',
      Source: 'wick.device',
      DetailType: 'card.retired',
      Detail: JSON.stringify({ householdId: 'margaret', deviceId: 'wick-tv', cardId: 'note-abc', at: 5 }),
    });
  });
});

describe('the visit, witnessed', () => {
  it('hands her yes or no to the agent plane, which keeps it and puts the card away everywhere', async () => {
    // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
    const { announcesRetirement, shouldPublish } = await import('../card-action-event.mjs');
    for (const action of ['visit_right', 'visit_wrong']) {
      expect(shouldPublish(action)).toBe(true);
      expect(announcesRetirement(action)).toBe(false);
    }
  });
});

