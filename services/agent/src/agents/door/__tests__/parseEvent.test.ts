import { describe, it, expect } from 'vitest';
import { isDoorWorthy, toRingHistoryEvent } from '../parseEvent.js';

describe('isDoorWorthy', () => {
  it('a button press is always door-worthy', () => {
    expect(isDoorWorthy({ event_type: 'button_press' })).toBe(true);
  });

  it('motion of a person is door-worthy', () => {
    expect(isDoorWorthy({ event_type: 'motion_detected', sub_type: 'human' })).toBe(true);
  });

  it('motion of a vehicle or package is NOT door-worthy — Principle 11, no noise', () => {
    expect(isDoorWorthy({ event_type: 'motion_detected', sub_type: 'vehicle' })).toBe(false);
    expect(isDoorWorthy({ event_type: 'motion_detected', sub_type: 'package' })).toBe(false);
  });

  it('motion with no sub_type at all is not door-worthy — refuse to guess', () => {
    expect(isDoorWorthy({ event_type: 'motion_detected' })).toBe(false);
  });

  it('account/device lifecycle events are never door-worthy', () => {
    for (const type of [
      'device_online',
      'device_offline',
      'device_added',
      'subscription_activated',
      'app_integration_added',
    ]) {
      expect(isDoorWorthy({ event_type: type })).toBe(false);
    }
  });

  it('accepts the camelCase field name too, matching webhook.mjs\'s own fallback', () => {
    expect(isDoorWorthy({ type: 'button_press' })).toBe(true);
  });
});

describe('toRingHistoryEvent', () => {
  const detail = {
    request_id: 'req-abc123',
    event_type: 'button_press',
    device_id: 'ava1.ring.device.ABNJQ',
    occurred_at: 1789455093305,
  };

  it('uses the request_id as the event id — already deduped by the webhook, and stable across redelivery (INV-6)', () => {
    expect(toRingHistoryEvent(detail, 'corr-1').id).toBe('req-abc123');
  });

  it('carries the device id and start time straight through', () => {
    const event = toRingHistoryEvent(detail, 'corr-1');
    expect(event.deviceId).toBe('ava1.ring.device.ABNJQ');
    expect(event.start).toBe(1789455093305);
  });

  it('carries the event type through', () => {
    expect(toRingHistoryEvent(detail, 'corr-1').eventType).toBe('button_press');
  });

  it('folds sub_type into detections when present', () => {
    const event = toRingHistoryEvent({ ...detail, event_type: 'motion_detected', sub_type: 'human' }, 'corr-1');
    expect(event.detections).toEqual(['human']);
  });

  it('reports no detections when there is no sub_type', () => {
    expect(toRingHistoryEvent(detail, 'corr-1').detections).toEqual([]);
  });

  it('accepts the camelCase field names too', () => {
    const event = toRingHistoryEvent(
      { requestId: 'req-xyz', deviceId: 'dev-1', occurredAt: 42, type: 'button_press' },
      'corr-1',
    );
    expect(event).toMatchObject({ id: 'req-xyz', deviceId: 'dev-1', start: 42, eventType: 'button_press' });
  });

  it('throws rather than building a card from a payload with no device id — a guess here is worse than silence', () => {
    expect(() => toRingHistoryEvent({ ...detail, device_id: undefined }, 'corr-1')).toThrow();
  });

  it('throws when there is no request id to derive a stable card id from', () => {
    expect(() => toRingHistoryEvent({ ...detail, request_id: undefined }, 'corr-1')).toThrow();
  });

  it('throws when there is no timestamp', () => {
    expect(() => toRingHistoryEvent({ ...detail, occurred_at: undefined }, 'corr-1')).toThrow();
  });
});
