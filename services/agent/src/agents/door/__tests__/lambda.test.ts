import { describe, it, expect, vi } from 'vitest';
import type { RingDevice } from '@wick/ring';
import type { QueuedCard } from '@wick/contracts';
import { routeRingEvent } from '../lambda.js';

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

describe('routeRingEvent', () => {
  it('a button press on a known device produces and sends a Phase 1 card', async () => {
    const findDevice = vi.fn(async () => device);
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    const result = await routeRingEvent(detail, {
      householdId: 'hh-1',
      findDevice,
      sendToDevice,
      now: () => 1789455094000,
    });

    expect(result).toBe('sent');
    expect(sendToDevice).toHaveBeenCalledTimes(1);
    const sent = sendToDevice.mock.calls[0]![0]!;
    expect(sent.card.type).toBe('DOOR');
    expect(sent.card.householdId).toBe('hh-1');
  });

  it('skips silently — no lookup, no send — for an event that is not door-worthy', async () => {
    const findDevice = vi.fn(async () => device);
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    const result = await routeRingEvent(
      { ...detail, event_type: 'subscription_activated' },
      { householdId: 'hh-1', findDevice, sendToDevice, now: () => 1789455094000 },
    );

    expect(result).toBe('skipped');
    expect(findDevice).not.toHaveBeenCalled();
    expect(sendToDevice).not.toHaveBeenCalled();
  });

  it('skips rather than guessing when the device has since been removed from the account', async () => {
    const findDevice = vi.fn(async () => undefined);
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    const result = await routeRingEvent(detail, {
      householdId: 'hh-1',
      findDevice,
      sendToDevice,
      now: () => 1789455094000,
    });

    expect(result).toBe('unknown_device');
    expect(sendToDevice).not.toHaveBeenCalled();
  });

  it('propagates a malformed payload rather than sending a broken card', async () => {
    const findDevice = vi.fn(async () => device);
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    await expect(
      routeRingEvent(
        { ...detail, device_id: undefined },
        { householdId: 'hh-1', findDevice, sendToDevice, now: () => 1789455094000 },
      ),
    ).rejects.toThrow();
    expect(sendToDevice).not.toHaveBeenCalled();
  });
});
