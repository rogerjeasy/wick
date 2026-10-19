/**
 * What the television is willing to believe of a frame from the wire.
 *
 * A frame is parsed inside a socket's own callback, where a throw is an
 * uncaught exception in a release build. So a frame that is not JSON, or is
 * JSON of the wrong shape, is dropped here with one line in the log, and
 * nothing else happens: the next frame is read as if it had never come.
 * Only the shape is checked — what a card or a control message means is the
 * edge's to decide and the card queue's to apply.
 */
import type { ControlMessage, DeviceWireMessage, QueuedCard } from '@wick/contracts';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A queued card is an object with its own id and a card that has a type. */
export function isQueuedCard(value: unknown): value is QueuedCard {
  return isObject(value) && typeof value.id === 'string' && isObject(value.card) && typeof value.card.type === 'string';
}

export function isControlMessage(value: unknown): value is ControlMessage {
  return isObject(value) && typeof value.t === 'string';
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function unreadable(where: string): undefined {
  console.warn('wire_frame_unreadable', where);
  return undefined;
}

/** One WebSocket frame: `{ kind: 'card', card }` or `{ kind: 'control', control }`. */
export function readWireMessage(data: unknown): DeviceWireMessage | undefined {
  const frame = parse(String(data));
  if (!isObject(frame)) return unreadable('websocket');
  if (frame.kind === 'card' && isQueuedCard(frame.card)) return { kind: 'card', card: frame.card };
  if (frame.kind === 'control' && isControlMessage(frame.control)) return { kind: 'control', control: frame.control };
  return unreadable('websocket');
}

/** The body of a message on the MQTT cards topic. */
export function readCardPayload(payload: { toString(encoding?: string): string }): QueuedCard | undefined {
  const card = parse(payload.toString('utf8'));
  return isQueuedCard(card) ? card : unreadable('mqtt_card');
}

/** The body of a message on the MQTT control topic. */
export function readControlPayload(payload: { toString(encoding?: string): string }): ControlMessage | undefined {
  const control = parse(payload.toString('utf8'));
  return isControlMessage(control) ? control : unreadable('mqtt_control');
}
