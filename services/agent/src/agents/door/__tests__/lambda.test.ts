import { describe, it, expect, vi } from 'vitest';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import type { QueuedCard, RosterEntry, VisitorMatch } from '@wick/contracts';
import { dispatchDoorEvent, routeDoorEvent, routeRingEvent, type RouteDeps } from '../lambda.js';

const device: RingDevice = {
  id: 'ava1.ring.device.ABNJQ',
  name: 'Front Door',
  online: true,
  capabilities: { motion: true, image: true, chime: true },
};

const detail = {
  request_id: 'req-abc123',
  event_type: 'button_press',
  device_id: device.id,
  occurred_at: 1789455093305,
  correlationId: 'corr-abc',
  receivedAt: 1789455093400,
};

function baseDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    householdId: 'hh-1',
    timeZone: 'UTC',
    findDevice: vi.fn(async () => device),
    hasHallwayChime: vi.fn(async () => false),
    listRoster: vi.fn(async () => []),
    listFamily: vi.fn(async () => []),
    recordPresence: vi.fn(async (_match: VisitorMatch, _at: number) => {}),
    recordDoorEvent: vi.fn(async (_at: number) => {}),
    recordDoorActivity: vi.fn(async (_deviceId: string, _subType: string, _measureName: 'motion' | 'button_press', _at: number) => {}),
    recordPresenceActivity: vi.fn(async (_personId: string, _at: number) => {}),
    noteSighting: vi.fn(async (_match: VisitorMatch | undefined, _at: number) => {}),
    sendToDevice: vi.fn(async (_card: QueuedCard) => {}),
    runPhase2: vi.fn(async (_cardId: string, _event: RingHistoryEvent) => ({
      image: 'patched' as const,
      description: 'patched' as const,
      reason: 'ok',
    })),
    now: () => 1789455094000,
    ...overrides,
  };
}

describe('routeRingEvent — the door says it rang (door.rang)', () => {
  it('puts the ring on the bus after the card is on its way: when, which card, and who it looked like', async () => {
    const order: string[] = [];
    const plumber: RosterEntry = { personId: 'errand:err_AAAAAAAAAAAAAAAAAAAA', name: 'the plumber', expectedOnce: { at: detail.occurred_at, windowMin: 60 }, addedBy: 'u_sarah', arrangedByName: 'Sarah' };
    const deps = baseDeps({
      listRoster: vi.fn(async () => [plumber]),
      sendToDevice: vi.fn(async () => void order.push('card')),
      announceRing: vi.fn(async () => void order.push('door.rang')),
    });

    expect(await routeRingEvent(detail, deps)).toBe('sent');

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(order).toEqual(['card', 'door.rang']);
    expect(deps.announceRing).toHaveBeenCalledWith({ householdId: 'hh-1', at: detail.occurred_at, cardId: sent.id, matchPersonId: plumber.personId });
  });

  it('says it rang with nobody matched, too', async () => {
    const deps = baseDeps({ announceRing: vi.fn(async () => {}) });
    await routeRingEvent(detail, deps);
    expect(vi.mocked(deps.announceRing!).mock.calls[0]![0]).not.toHaveProperty('matchPersonId');
  });

  it('never lets a failed put cost the card, the timeline or the picture', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = baseDeps({ announceRing: vi.fn(async () => { throw new Error('bus down'); }) });

    expect(await routeRingEvent(detail, deps)).toBe('sent');

    expect(deps.sendToDevice).toHaveBeenCalledTimes(1);
    expect(deps.recordDoorEvent).toHaveBeenCalledTimes(1);
    expect(deps.runPhase2).toHaveBeenCalledTimes(1);
    expect(error.mock.calls.flat().join(' ')).toContain('door_rang_not_put');
    error.mockRestore();
  });

  it('does not say it rang for a person seen at the door who did not press the bell: an errand waits for a ring, not a passer-by', async () => {
    const deps = baseDeps({ announceRing: vi.fn(async () => {}) });
    expect(await routeRingEvent({ ...detail, event_type: 'motion_detected', sub_type: 'human' }, deps)).toBe('sent');
    expect(deps.sendToDevice).toHaveBeenCalledTimes(1);
    expect(deps.announceRing).not.toHaveBeenCalled();
  });

  it('does not say it rang for an event that is not a ring', async () => {
    const deps = baseDeps({ announceRing: vi.fn(async () => {}) });
    await routeRingEvent({ ...detail, event_type: 'subscription_activated' }, deps);
    expect(deps.announceRing).not.toHaveBeenCalled();
  });
});

describe('routeRingEvent', () => {
  it('asks the household-level question for the chime button, not the doorbell', async () => {
    const deps = baseDeps({ hasHallwayChime: vi.fn(async () => true) });
    await routeRingEvent(detail, deps);
    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(sent.card.actions.map((a) => a.id)).toContain('hallway_chime');
  });

  it('leaves the chime button off when the chime lookup fails, and still sends the card', async () => {
    const deps = baseDeps({ hasHallwayChime: vi.fn(async () => { throw new Error('ring down'); }) });
    expect(await routeRingEvent(detail, deps)).toBe('sent');
    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(sent.card.actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('offers to ask the family when the resident has allowed someone and nobody is expected', async () => {
    const deps = baseDeps({ listFamily: vi.fn(async () => ['Sarah']) });

    await routeRingEvent(detail, deps);

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0];
    expect(sent.card.actions.map((a) => a.id)).toEqual(['watch_live', 'ask_family', 'dismiss']);
  });

  it('leaves the ask button off when the circle cannot be read, and still sends the card', async () => {
    const deps = baseDeps({ listFamily: vi.fn(async () => { throw new Error('table down'); }) });

    expect(await routeRingEvent(detail, deps)).toBe('sent');

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0];
    expect(sent.card.actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('a button press on a known device produces and sends a Phase 1 card', async () => {
    const deps = baseDeps();

    const result = await routeRingEvent(detail, deps);

    expect(result).toBe('sent');
    expect(deps.sendToDevice).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(sent.card.type).toBe('DOOR');
    expect(sent.card.householdId).toBe('hh-1');
  });

  it('skips silently — no lookup, no send — for an event that is not door-worthy', async () => {
    const deps = baseDeps();

    const result = await routeRingEvent({ ...detail, event_type: 'subscription_activated' }, deps);

    expect(result).toBe('skipped');
    expect(deps.findDevice).not.toHaveBeenCalled();
    expect(deps.sendToDevice).not.toHaveBeenCalled();
    expect(deps.runPhase2).not.toHaveBeenCalled();
  });

  it('skips rather than guessing when the device has since been removed from the account', async () => {
    const deps = baseDeps({ findDevice: vi.fn(async () => undefined) });

    const result = await routeRingEvent(detail, deps);

    expect(result).toBe('unknown_device');
    expect(deps.sendToDevice).not.toHaveBeenCalled();
    expect(deps.runPhase2).not.toHaveBeenCalled();
  });

  it('still tells her someone is at the door when Ring does not answer the device list, offering nothing that needs Ring', async () => {
    const deps = baseDeps({
      findDevice: vi.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }),
      hasHallwayChime: vi.fn(async () => true),
    });

    expect(await routeRingEvent(detail, deps)).toBe('sent');

    expect(deps.sendToDevice).toHaveBeenCalledTimes(1);
    const [sent, ringDeviceId] = vi.mocked(deps.sendToDevice).mock.calls[0]!;
    expect(sent.card.type).toBe('DOOR');
    expect(sent.card.householdId).toBe('hh-1');
    // Live view and the chime both need Ring: a button that would fail when pressed is left off (D6).
    expect(sent.card.actions.map((a) => a.id)).toEqual(['dismiss']);
    // The doorbell is the one the ring named, kept beside the card for when Ring is back.
    expect(ringDeviceId).toBe(device.id);
    // The chime question is Ring's too, and is not asked of a Ring that is not answering.
    expect(deps.hasHallwayChime).not.toHaveBeenCalled();
    // The picture is still tried: Ring may be back by then, and Phase 2 already stands a failure.
    expect(deps.runPhase2).toHaveBeenCalledTimes(1);
  });

  it('still offers to ask the family when Ring does not answer — that button needs no Ring', async () => {
    const deps = baseDeps({
      findDevice: vi.fn(async () => { throw new Error('ring_api_503'); }),
      listFamily: vi.fn(async () => ['Sarah']),
    });

    await routeRingEvent(detail, deps);

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0];
    expect(sent.card.actions.map((a) => a.id)).toEqual(['ask_family', 'dismiss']);
  });

  it('propagates a malformed payload rather than sending a broken card', async () => {
    const deps = baseDeps();

    await expect(routeRingEvent({ ...detail, device_id: undefined }, deps)).rejects.toThrow();
    expect(deps.sendToDevice).not.toHaveBeenCalled();
    expect(deps.runPhase2).not.toHaveBeenCalled();
  });

  it('runs Phase 2 against the sent card and the original event, after Phase 1 is on its way', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    const sentCardId = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!.id;
    expect(deps.runPhase2).toHaveBeenCalledTimes(1);
    const [cardId, event] = vi.mocked(deps.runPhase2).mock.calls[0]!;
    expect(cardId).toBe(sentCardId);
    expect(event.deviceId).toBe(device.id);
  });

  it('logs the Phase 2 outcome under the correlation id — a missing picture is never silent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps = baseDeps({
      runPhase2: vi.fn(async () => ({
        image: 'unavailable' as const,
        description: 'skipped' as const,
        reason: 'ring_api_416_MEDIA_NOT_FOUND: No media found in time range 1-2',
      })),
    });

    await routeRingEvent(detail, deps);

    const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    expect(lines).toContainEqual({
      level: 'info',
      msg: 'phase2_outcome',
      correlationId: 'corr-abc',
      image: 'unavailable',
      description: 'skipped',
      reason: 'ring_api_416_MEDIA_NOT_FOUND: No media found in time range 1-2',
    });
    log.mockRestore();
  });

  it('still reports "sent" when Phase 2 fails — Phase 1 already reached the device', async () => {
    const deps = baseDeps({
      runPhase2: vi.fn(async () => {
        throw new Error('bedrock_down');
      }),
    });

    await expect(routeRingEvent(detail, deps)).resolves.toBe('sent');
  });

  it('M4: carries a roster match onto the sent card when the event time fits an entry', async () => {
    // detail.occurred_at is Tuesday 2026-09-15 06:51 UTC.
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent(detail, deps);

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(sent.card.type).toBe('DOOR');
    if (sent.card.type !== 'DOOR') throw new Error('unreachable');
    expect(sent.card.match).toMatchObject({ personId: 'maria', name: 'Maria' });
  });

  it('M4: no match at all is the default — most events are not a known visitor', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    if (sent.card.type !== 'DOOR') throw new Error('unreachable');
    expect(sent.card.match).toBeUndefined();
  });

  it('M5: records presence on the timeline when the event matches the roster', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent(detail, deps);

    expect(deps.recordPresence).toHaveBeenCalledTimes(1);
    const [match, at] = vi.mocked(deps.recordPresence).mock.calls[0]!;
    expect(match.personId).toBe('maria');
    expect(at).toBe(1789455093305); // the event's own timestamp, not now()
  });

  it('M5: never records presence when nobody on the roster matches', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    expect(deps.recordPresence).not.toHaveBeenCalled();
  });

  it('M5: still reports "sent" when recording presence fails — the card already reached the device', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({
      listRoster: vi.fn(async () => [maria]),
      recordPresence: vi.fn(async () => {
        throw new Error('ddb_down');
      }),
    });

    await expect(routeRingEvent(detail, deps)).resolves.toBe('sent');
  });

  it('D3: records a generic door event on the timeline for every door-worthy event', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    expect(deps.recordDoorEvent).toHaveBeenCalledTimes(1);
    // The event's own timestamp; a person seen who did not ring is marked so (presence.ts).
    expect(deps.recordDoorEvent).toHaveBeenCalledWith(1789455093305, false);
  });

  it('D3: records the door event even when the same event also matches the roster — both are real, both are written', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent(detail, deps);

    expect(deps.recordDoorEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordPresence).toHaveBeenCalledTimes(1);
  });

  it('somebody seen who did not ring: marked as seen, and never taken for the visitor expected', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent({ ...detail, event_type: 'motion_detected', sub_type: 'human' }, deps);

    expect(deps.recordDoorEvent).toHaveBeenCalledWith(1789455093305, true);
    expect(deps.recordPresence).not.toHaveBeenCalled();
  });

  it('D3: still reports "sent" when recording the door event fails', async () => {
    const deps = baseDeps({
      recordDoorEvent: vi.fn(async () => {
        throw new Error('ddb_down');
      }),
    });

    await expect(routeRingEvent(detail, deps)).resolves.toBe('sent');
  });

  it('S6: records door activity for the Rhythm baseline on every door-worthy event — button press has no sub_type, so it falls back to "button"', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    expect(deps.recordDoorActivity).toHaveBeenCalledTimes(1);
    expect(deps.recordDoorActivity).toHaveBeenCalledWith(device.id, 'button', 'button_press', 1789455093305);
  });

  it('S6: a motion event with a detected sub_type carries it as the dimension and maps to the "motion" measure', async () => {
    const deps = baseDeps();
    const motionDetail = {
      ...detail,
      event_type: 'motion_detected',
      sub_type: 'human',
    };

    await routeRingEvent(motionDetail, deps);

    expect(deps.recordDoorActivity).toHaveBeenCalledWith(device.id, 'human', 'motion', 1789455093305);
  });

  it('S6: still reports "sent" when recording door activity fails — the card already reached the device', async () => {
    const deps = baseDeps({
      recordDoorActivity: vi.fn(async () => {
        throw new Error('ddb_down');
      }),
    });

    await expect(routeRingEvent(detail, deps)).resolves.toBe('sent');
  });

  it('S6: records presence activity for the Rhythm baseline when the event matches the roster', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent(detail, deps);

    expect(deps.recordPresenceActivity).toHaveBeenCalledTimes(1);
    expect(deps.recordPresenceActivity).toHaveBeenCalledWith('maria', 1789455093305);
  });

  it('tells the visit record of every sighting: who it looked like, or that it looked like nobody', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const matched = baseDeps({ listRoster: vi.fn(async () => [maria]) });
    await routeRingEvent(detail, matched);
    expect(matched.noteSighting).toHaveBeenCalledWith(expect.objectContaining({ personId: 'maria', name: 'Maria' }), 1789455093305);

    const stranger = baseDeps();
    await routeRingEvent(detail, stranger);
    expect(stranger.noteSighting).toHaveBeenCalledWith(undefined, 1789455093305);
  });

  it('still reports "sent", and still describes the visitor, when the visit record cannot be written', async () => {
    const deps = baseDeps({ noteSighting: vi.fn(async () => { throw new Error('ddb_down'); }) });
    expect(await routeRingEvent(detail, deps)).toBe('sent');
    expect(deps.runPhase2).toHaveBeenCalledTimes(1);
  });

  it('S6: never records presence activity when nobody on the roster matches', async () => {
    const deps = baseDeps();

    await routeRingEvent(detail, deps);

    expect(deps.recordPresenceActivity).not.toHaveBeenCalled();
  });

  it('S6: still reports "sent" when recording presence activity fails', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({
      listRoster: vi.fn(async () => [maria]),
      recordPresenceActivity: vi.fn(async () => {
        throw new Error('ddb_down');
      }),
    });

    await expect(routeRingEvent(detail, deps)).resolves.toBe('sent');
  });
});

describe('routeDoorEvent', () => {
  it('sends the ring to the household that holds the doorbell, and to no other', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const householdOf = vi.fn(async (_deviceId: string) => 'hh-b');
    const depsFor = vi.fn((householdId: string) => baseDeps({ householdId, sendToDevice }));

    const result = await routeDoorEvent(detail, { householdOf, depsFor });

    expect(result).toBe('sent');
    expect(householdOf).toHaveBeenCalledWith('ava1.ring.device.ABNJQ');
    expect(depsFor.mock.calls).toEqual([['hh-b']]);
    expect(sendToDevice.mock.calls.map(([card]) => card.card.householdId)).toEqual(['hh-b']);
  });

  it('puts a ring from a doorbell no household holds on no television at all', async () => {
    const depsFor = vi.fn((householdId: string) => baseDeps({ householdId }));

    const result = await routeDoorEvent(detail, { householdOf: async () => undefined, depsFor });

    expect(result).toBe('unclaimed_device');
    expect(depsFor).not.toHaveBeenCalled();
  });

  it('skips an event that is not door-worthy without asking whose doorbell it is', async () => {
    const householdOf = vi.fn(async (_deviceId: string) => 'hh-b');

    const result = await routeDoorEvent(
      { ...detail, event_type: 'subscription_activated' },
      { householdOf, depsFor: (householdId) => baseDeps({ householdId }) },
    );

    expect(result).toBe('skipped');
    expect(householdOf).not.toHaveBeenCalled();
  });
});

describe('routeDoorEvent — the doorbell heard (packages/contracts heard.ts)', () => {
  it('notes every doorbell event of a household as heard — a car going past as well as a visitor — and only the visitor reaches the television', async () => {
    const heard = vi.fn(async (_householdId: string, _at: number) => {});
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const routing = { householdOf: async () => 'hh-b', depsFor: (householdId: string) => baseDeps({ householdId, sendToDevice }), heard };

    expect(await routeDoorEvent({ ...detail, event_type: 'motion_detected', sub_type: 'vehicle' }, routing)).toBe('skipped');
    expect(await routeDoorEvent(detail, routing)).toBe('sent');

    expect(heard.mock.calls).toEqual([['hh-b', detail.occurred_at], ['hh-b', detail.occurred_at]]);
    expect(sendToDevice).toHaveBeenCalledTimes(1);
  });

  it('notes nothing for a doorbell no household holds, or an event that is not a doorbell’s', async () => {
    const heard = vi.fn(async (_householdId: string, _at: number) => {});
    expect(await routeDoorEvent(detail, { householdOf: async () => undefined, depsFor: (householdId) => baseDeps({ householdId }), heard })).toBe('unclaimed_device');
    expect(await routeDoorEvent({ ...detail, event_type: 'subscription_activated' }, { householdOf: async () => 'hh-b', depsFor: (householdId) => baseDeps({ householdId }), heard })).toBe('skipped');
    expect(heard).not.toHaveBeenCalled();
  });

  it('never loses a ring because the note could not be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const result = await routeDoorEvent(detail, {
      householdOf: async () => 'hh-b',
      depsFor: (householdId) => baseDeps({ householdId, sendToDevice }),
      heard: async () => {
        throw new Error('throttled');
      },
    });
    expect(result).toBe('sent');
    expect(sendToDevice).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

describe('routeDoorEvent — the claim row authorizes, Ring\'s device list only says Ring is answering', () => {
  const ringDown = () => vi.fn(async (_deviceId: string): Promise<RingDevice | undefined> => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  });

  it('sends nothing for a doorbell no household has claimed, even when Ring is not answering', async () => {
    const findDevice = ringDown();
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const runPhase2 = vi.fn(async () => ({ image: 'patched' as const, description: 'patched' as const, reason: 'ok' }));
    const depsFor = vi.fn((householdId: string) => baseDeps({ householdId, findDevice, sendToDevice, runPhase2 }));

    const result = await routeDoorEvent(detail, { householdOf: async () => undefined, depsFor });

    expect(result).toBe('unclaimed_device');
    expect(depsFor).not.toHaveBeenCalled();
    expect(findDevice).not.toHaveBeenCalled();
    expect(sendToDevice).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
  });

  it('sends a claimed doorbell\'s card to its own household when Ring is not answering: no chime, no Watch live, and the picture tried only by Phase 2, once', async () => {
    const findDevice = ringDown();
    const hasHallwayChime = vi.fn(async () => true);
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const runPhase2 = vi.fn(async (_cardId: string, _event: RingHistoryEvent) => ({ image: 'unavailable' as const, description: 'skipped' as const, reason: 'frame_deadline' }));
    const depsFor = vi.fn((householdId: string) => baseDeps({ householdId, findDevice, hasHallwayChime, sendToDevice, runPhase2 }));

    const result = await routeDoorEvent(detail, { householdOf: async () => 'hh-b', depsFor });

    expect(result).toBe('sent');
    expect(depsFor.mock.calls).toEqual([['hh-b']]);
    expect(findDevice).toHaveBeenCalledTimes(1);
    expect(hasHallwayChime).not.toHaveBeenCalled();
    expect(sendToDevice).toHaveBeenCalledTimes(1);
    const sent = sendToDevice.mock.calls[0]![0];
    expect(sent.card.householdId).toBe('hh-b');
    expect(sent.card.actions.map((a) => a.id)).toEqual(['dismiss']);
    // The only Ring work after the card is Phase 2's own, under its frame deadline (phase2.ts withinDeadline).
    expect(runPhase2).toHaveBeenCalledTimes(1);
    expect(runPhase2.mock.calls[0]![0]).toBe(sent.id);
  });

  it('still reaches nobody when Ring answers that the doorbell is not on this household\'s link', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});
    const runPhase2 = vi.fn(async () => ({ image: 'patched' as const, description: 'patched' as const, reason: 'ok' }));
    const depsFor = vi.fn((householdId: string) => baseDeps({ householdId, findDevice: vi.fn(async () => undefined), sendToDevice, runPhase2 }));

    const result = await routeDoorEvent(detail, { householdOf: async () => 'hh-b', depsFor });

    expect(result).toBe('unknown_device');
    expect(sendToDevice).not.toHaveBeenCalled();
    expect(runPhase2).not.toHaveBeenCalled();
  });
});

describe('dispatchDoorEvent — a Ring doorbell or a demo home’s stand-in', () => {
  const routes = () => ({ ring: vi.fn(async () => 'sent' as const), demo: vi.fn(async () => 'sent' as const) });

  it('takes the stand-in’s path only for the stand-in’s own source', async () => {
    const r = routes();
    await dispatchDoorEvent({ source: 'wick.demo-door', detail: { householdId: 'hh-demo' } }, r);
    expect(r.demo).toHaveBeenCalledWith({ householdId: 'hh-demo' });
    expect(r.ring).not.toHaveBeenCalled();
  });

  it('takes everything else down the Ring path, whatever its detail says', async () => {
    const r = routes();
    await dispatchDoorEvent({ source: 'wick.ring', detail: { householdId: 'hh-demo', visitor: 'carer' } }, r);
    await dispatchDoorEvent({ detail }, r);
    expect(r.ring).toHaveBeenCalledTimes(2);
    expect(r.demo).not.toHaveBeenCalled();
  });
});
