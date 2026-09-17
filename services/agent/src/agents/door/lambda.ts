/**
 * EventBridge entrypoint — a `wick.ring` event becomes a real card on the
 * device. The composition root for S1's Phase 1 path:
 *
 *   webhook.mjs -> EventBridge "wick" bus -> (this) -> sendToDevice
 *
 * `routeRingEvent` is the part worth unit testing — gating, device lookup,
 * error propagation — with every AWS client injected. `handler` is the thin
 * shim that wires the real ones, in the same style as webhook.mjs and
 * connect.mjs: composition, not logic, so it is left untested the same way
 * those are.
 *
 * Household resolution is hardcoded to one household via WICK_HOUSEHOLD_ID.
 * There is no Ring-device -> household registry in this repo yet, and the
 * product is built around one real household (docs/WICK.md §2). Multi-
 * household is Tier 3 (§4.5), not S1 — do not build a registry for it here.
 *
 * Phase 2 (image + description patches) is not wired yet: egress.ts has no
 * patch-delivery path. This handler ships Phase 1 only, which the product
 * doc is explicit is "still useful" on its own (§5.2).
 */
import type { RingDevice } from '@wick/ring';
import { RingClient, cachedDeviceLookup, listDevices, secretsManagerTokenProvider } from '@wick/ring';
import type { QueuedCard } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { handleDoorEvent } from './handle.js';
import { isDoorWorthy, toRingHistoryEvent } from './parseEvent.js';
import { sendToDevice as realSendToDevice } from '../../egress.js';

export type RouteResult = 'sent' | 'skipped' | 'unknown_device';

export interface RouteDeps {
  readonly householdId: string;
  readonly findDevice: (deviceId: string) => Promise<RingDevice | undefined>;
  readonly sendToDevice: (card: QueuedCard) => Promise<void>;
  readonly now: () => number;
}

/**
 * One EventBridge detail through the whole Phase 1 path.
 *
 * Order matters: the door-worthiness gate runs BEFORE any device lookup, so
 * an account-lifecycle event (subscription_activated and the like) never
 * costs a Ring API call — most events on the bus are not doorbell events.
 */
export async function routeRingEvent(
  detail: Record<string, unknown>,
  deps: RouteDeps,
): Promise<RouteResult> {
  if (!isDoorWorthy(detail)) return 'skipped';

  const correlationId = typeof detail.correlationId === 'string' ? detail.correlationId : '';
  const event = toRingHistoryEvent(detail, correlationId);

  const device = await deps.findDevice(event.deviceId);
  if (!device) return 'unknown_device';

  await handleDoorEvent(
    { event, device, householdId: deps.householdId, correlationId, now: deps.now() },
    { sendToDevice: deps.sendToDevice },
  );

  return 'sent';
}

interface EventBridgeEnvelope {
  readonly detail: Record<string, unknown>;
}

let lookupDevice: ((deviceId: string) => Promise<RingDevice | undefined>) | undefined;

export const handler = async (evt: EventBridgeEnvelope): Promise<void> => {
  const householdId = process.env.WICK_HOUSEHOLD_ID;
  if (!householdId) throw new Error('WICK_HOUSEHOLD_ID not set');

  lookupDevice ??= cachedDeviceLookup({
    list: () => listDevices(new RingClient({ getToken: secretsManagerTokenProvider() })),
  });

  const result = await routeRingEvent(evt.detail, {
    householdId,
    findDevice: lookupDevice,
    sendToDevice: (card) => realSendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
  });

  console.log(JSON.stringify({ level: 'info', msg: 'door_event_routed', result }));
};
