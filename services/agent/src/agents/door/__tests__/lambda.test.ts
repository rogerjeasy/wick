import { describe, it, expect, vi } from 'vitest';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import type { QueuedCard, RosterEntry, VisitorMatch } from '@wick/contracts';
import { routeRingEvent, type RouteDeps } from '../lambda.js';

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
    findDevice: vi.fn(async () => device),
    listRoster: vi.fn(async () => []),
    recordPresence: vi.fn(async (_match: VisitorMatch, _at: number) => {}),
    recordDoorEvent: vi.fn(async (_at: number) => {}),
    recordDoorActivity: vi.fn(async (_deviceId: string, _subType: string, _measureName: 'motion' | 'button_press', _at: number) => {}),
    recordPresenceActivity: vi.fn(async (_personId: string, _at: number) => {}),
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

describe('routeRingEvent', () => {
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
    expect(deps.recordDoorEvent).toHaveBeenCalledWith(1789455093305); // the event's own timestamp
  });

  it('D3: records the door event even when the same event also matches the roster — both are real, both are written', async () => {
    const maria: RosterEntry = { personId: 'maria', name: 'Maria', expectedPattern: 'TUE 06:51±30m' };
    const deps = baseDeps({ listRoster: vi.fn(async () => [maria]) });

    await routeRingEvent(detail, deps);

    expect(deps.recordDoorEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordPresence).toHaveBeenCalledTimes(1);
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
