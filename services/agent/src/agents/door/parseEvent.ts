/**
 * Ring webhook detail -> the shape handleDoorEvent needs.
 *
 * The webhook (edge-ring webhook-receiver.mjs `readRingEvent`) reads Ring's
 * v1.1 envelope (`meta.request_id`, `data.type`, `data.attributes.{source,
 * timestamp, sub_type}`) into a flat detail and puts it, with `correlationId`
 * and `receivedAt`, on the `wick` bus: `request_id`, `event_type`, `sub_type`,
 * `device_id`, `occurred_at`. This module turns that into a RingHistoryEvent
 * and decides whether it is worth a card at all.
 *
 * The webhook payload has no history-API event id, so `request_id` — already
 * unique and already deduped by webhook.mjs's idempotency write — stands in
 * for it. That keeps `cardIdFor` (index.ts) stable across a redelivered
 * webhook, which is the whole point of INV-6.
 */
import type { RingHistoryEvent } from '@wick/ring';

type Detail = Record<string, unknown>;

const field = (detail: Detail, snake: string, camel: string): unknown => detail[snake] ?? detail[camel];

/**
 * Only a real visitor gets the resident's attention. A car or a parcel
 * passing the camera is motion, not a person at the door — surfacing it as
 * "someone's at the door" would be a false claim, not just noise (Principle
 * 11: no confident guessing). Absent sub_type is refused for the same
 * reason: better silent than wrong.
 */
export function isDoorWorthy(detail: Detail): boolean {
  const type = field(detail, 'event_type', 'type');
  if (type === 'button_press') return true;
  if (type === 'motion_detected') return field(detail, 'sub_type', 'subType') === 'human';
  return false;
}

export function toRingHistoryEvent(detail: Detail, _correlationId: string): RingHistoryEvent {
  const deviceId = field(detail, 'device_id', 'deviceId');
  const requestId = field(detail, 'request_id', 'requestId');
  const occurredAt = field(detail, 'occurred_at', 'occurredAt');
  const eventType = field(detail, 'event_type', 'type');
  const subType = field(detail, 'sub_type', 'subType');

  if (typeof deviceId !== 'string' || !deviceId) {
    throw new Error('ring event missing device_id');
  }
  if (typeof requestId !== 'string' || !requestId) {
    throw new Error('ring event missing request_id');
  }
  if (typeof occurredAt !== 'number') {
    throw new Error('ring event missing occurred_at');
  }

  return {
    id: requestId,
    deviceId,
    start: occurredAt,
    eventType: typeof eventType === 'string' ? eventType : 'unknown',
    detections: typeof subType === 'string' ? [subType] : [],
  };
}
