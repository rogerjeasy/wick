import { describe, it, expect } from 'vitest';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { buildCardActionEntry, shouldPublish } from '../card-action-event.mjs';

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
