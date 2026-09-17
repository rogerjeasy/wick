import { describe, it, expect, vi } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import { handleDoorEvent } from '../handle.js';

const device: RingDevice = {
  id: 'ava1.ring.device.ABNJQ',
  name: 'Front Door',
  online: true,
  capabilities: { motion: true, image: true, chime: true },
};

const event: RingHistoryEvent = {
  id: 'ava1.ring.history.event.XWRR',
  deviceId: 'ava1.ring.device.ABNJQ',
  start: 1789455093305,
  end: 1789455104824,
  eventType: 'ding',
  detections: [],
};

const input = {
  event,
  device,
  householdId: 'hh-1',
  correlationId: 'corr-abc',
  now: 1789455094000,
};

describe('handleDoorEvent', () => {
  it('sends a Phase 1 card to the device, queued as DOOR urgency', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    await handleDoorEvent(input, { sendToDevice });

    expect(sendToDevice).toHaveBeenCalledTimes(1);
    const sent = sendToDevice.mock.calls[0]![0]!;
    expect(sent.urgency).toBe('DOOR');
    expect(sent.card.type).toBe('DOOR');
    expect(sent.card.id).toBe(sent.id);
    expect(sent.queuedAt).toBe(input.now);
    expect(sent.shownCount).toBe(0);
  });

  it('carries the plain-English line and correlationId onto the sent card', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    await handleDoorEvent(input, { sendToDevice });

    const sent = sendToDevice.mock.calls[0]![0]!;
    expect(sent.card.type).toBe('DOOR');
    if (sent.card.type !== 'DOOR') throw new Error('unreachable');
    expect(sent.card.line).toBe("Someone's at the front door.");
    expect(sent.card.correlationId).toBe('corr-abc');
  });

  it('never blocks on an image or description — Phase 1 ships without them', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    await handleDoorEvent(input, { sendToDevice });

    const sent = sendToDevice.mock.calls[0]![0]!;
    if (sent.card.type !== 'DOOR') throw new Error('unreachable');
    expect(sent.card.imageRef).toBeUndefined();
    expect(sent.card.description).toBeUndefined();
  });

  it('propagates a send failure rather than swallowing it', async () => {
    const sendToDevice = vi.fn(async () => {
      throw new Error('ws_down');
    });

    await expect(handleDoorEvent(input, { sendToDevice })).rejects.toThrow('ws_down');
  });

  it('resolves with the queued card it sent, for the caller to log', async () => {
    const sendToDevice = vi.fn(async (_card: QueuedCard) => {});

    const result = await handleDoorEvent(input, { sendToDevice });

    expect(result).toBe(sendToDevice.mock.calls[0]![0]!);
  });
});
