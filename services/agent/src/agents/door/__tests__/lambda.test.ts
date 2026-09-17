import { describe, it, expect, vi } from 'vitest';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import type { QueuedCard, RosterEntry } from '@wick/contracts';
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
    sendToDevice: vi.fn(async (_card: QueuedCard) => {}),
    runPhase2: vi.fn(async (_cardId: string, _event: RingHistoryEvent) => {}),
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
});
