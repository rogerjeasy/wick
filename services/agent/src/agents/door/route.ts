/**
 * The door path itself, with every client injected: whose doorbell it is,
 * gating, the device, the card, the timeline, the visit and Phase 2.
 *
 * Moved out of lambda.ts so that a path with no Ring at all — a demo home's
 * stand-in doorbell (demoDoor.ts) — can run exactly this code without
 * importing the module that builds Ring clients. Nothing here imports a
 * Ring value: what is Ring's arrives through `RouteDeps`.
 */
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import type { DoorRangDetail, QueuedCard, RosterEntry, VisitorMatch } from '@wick/contracts';
import { handleDoorEvent } from './handle.js';
import { isDoorWorthy, toRingHistoryEvent } from './parseEvent.js';
import { matchVisitor } from './roster.js';
import type { Phase2Outcome } from './phase2.js';

export type RouteResult = 'sent' | 'skipped' | 'unknown_device' | 'unclaimed_device';

/** The doorbell as far as the card needs it — its id — when Ring could not be asked for the rest. */
function doorbellRingDidNotDescribe(id: string): RingDevice {
  return { id, name: '', online: true, capabilities: { motion: false, image: false, chime: false } };
}

export interface RouteDeps {
  readonly householdId: string;
  readonly findDevice: (deviceId: string) => Promise<RingDevice | undefined>;
  /** M1. A playable Ring Chime exists — from the same cached list as findDevice, so no extra Ring call. */
  readonly hasHallwayChime: () => Promise<boolean>;
  /** M4. Most households have not curated one; an empty list is the common answer. */
  readonly listRoster: () => Promise<readonly RosterEntry[]>;
  /** The names of the people the resident has allowed into the family circle — who "Ask Sarah to look" can reach. */
  readonly listFamily: () => Promise<readonly string[]>;
  /** M5. Only called when the event actually matches the roster. */
  readonly recordPresence: (match: VisitorMatch, at: number) => Promise<void>;
  /** D3. Called for every door-worthy event, matched or not. */
  readonly recordDoorEvent: (at: number) => Promise<void>;
  /** S6. Every door-worthy event's occurrence, for the Rhythm baseline (§8.2's door_activity table). */
  readonly recordDoorActivity: (
    deviceId: string,
    subType: string,
    measureName: 'motion' | 'button_press',
    at: number,
  ) => Promise<void>;
  /** S6. Written only on a roster match — an arrival occurrence for the Rhythm baseline (§8.2's presence table). */
  readonly recordPresenceActivity: (personId: string, at: number) => Promise<void>;
  /**
   * The visit, witnessed (agents/visit/note.ts): every door-worthy sighting, with who it looked like or nobody —
   * a regular visitor arriving opens a visit, and anybody seen later is taken as that visitor leaving.
   */
  readonly noteSighting: (match: VisitorMatch | undefined, at: number) => Promise<void>;
  readonly sendToDevice: (card: QueuedCard, ringDeviceId: string) => Promise<void>;
  readonly runPhase2: (cardId: string, event: RingHistoryEvent) => Promise<Phase2Outcome>;
  /**
   * Says on the bus that the door rang (announce.ts), for a visit errand
   * waiting for it. After the card, and best-effort: a failure is logged.
   * Absent, nothing is said.
   */
  readonly announceRing?: (detail: DoorRangDetail) => Promise<void>;
  readonly now: () => number;
  /**
   * A demo home's stand-in doorbell (demoDoor.ts): the card says so, and
   * offers no live view and no chime (index.ts). Absent for every real one.
   */
  readonly standIn?: boolean;
}

/**
 * One EventBridge detail through the whole path.
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

  // Ring's device list confirms the household's own link can still see this
  // doorbell. When Ring does not answer it (slow, down, or a token that has
  // run out), the doorbell is still this household's — routeDoorEvent found
  // its RINGDEV# row, which Ring is not asked for — so she is still told
  // someone is at the door. Phase 1 makes no Ring call by design (index.ts);
  // waiting on one here used to throw instead, and the card never came. A
  // device Ring says is not on the link at all is a different answer, and
  // still reaches nobody. The authorization is the RINGDEV# claim row, read
  // in routeDoorEvent before this and released when a link is disconnected;
  // Ring's device list here is only a check that Ring is answering.
  let device: RingDevice | undefined;
  let ringUnanswered = false;
  try {
    device = await deps.findDevice(event.deviceId);
  } catch (err) {
    ringUnanswered = true;
    device = doorbellRingDidNotDescribe(event.deviceId);
    console.warn(JSON.stringify({
      level: 'warn', msg: 'ring_device_list_failed', correlationId,
      err: err instanceof Error ? err.name || err.message : String(err),
    }));
  }
  if (!device) return 'unknown_device';

  const roster = await deps.listRoster();
  // A failed lookup costs the button, never the card.
  const hallwayChime = ringUnanswered ? false : await deps.hasHallwayChime().catch(() => false);
  const family = await deps.listFamily().catch(() => []);

  const queued = await handleDoorEvent(
    {
      event, device, hallwayChime, householdId: deps.householdId, correlationId, now: deps.now(), roster, family,
      ...(deps.standIn ? { standIn: true } : {}),
      ...(ringUnanswered ? { ringUnanswered: true } : {}),
    },
    { sendToDevice: deps.sendToDevice },
  );

  if (deps.announceRing) {
    // After the card is on its way, and never at its cost: an errand that misses a ring says nobody came.
    const looksLike = queued.card.type === 'DOOR' ? queued.card.match?.personId : undefined;
    try {
      await deps.announceRing({ householdId: deps.householdId, at: event.start, cardId: queued.id, ...(looksLike ? { matchPersonId: looksLike } : {}) });
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', msg: 'door_rang_not_put', correlationId,
        err: err instanceof Error ? err.name || err.message : String(err),
      }));
    }
  }

  try {
    await deps.recordDoorEvent(event.start);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'record_door_event_failed', correlationId,
      err: err instanceof Error ? err.message : String(err),
    }));
  }

  try {
    // Button presses carry no sub_type (parseEvent.ts) — 'button' is the
    // fixed dimension value for the one door-worthy event type that isn't
    // motion. A motion event always has one, since isDoorWorthy() already
    // required sub_type === 'human' to get this far.
    const subType = event.detections[0] ?? 'button';
    const measureName = event.eventType === 'button_press' ? 'button_press' : 'motion';
    await deps.recordDoorActivity(event.deviceId, subType, measureName, event.start);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'record_door_activity_failed', correlationId,
      err: err instanceof Error ? err.message : String(err),
    }));
  }

  const match = matchVisitor(roster, event.start);
  if (match) {
    try {
      await deps.recordPresence(match, event.start);
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', msg: 'record_presence_failed', correlationId,
        err: err instanceof Error ? err.message : String(err),
      }));
    }

    try {
      await deps.recordPresenceActivity(match.personId, event.start);
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', msg: 'record_presence_activity_failed', correlationId,
        err: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  try {
    await deps.noteSighting(match ?? undefined, event.start);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'visit_note_failed', correlationId,
      err: err instanceof Error ? err.message : String(err),
    }));
  }

  try {
    const outcome = await deps.runPhase2(queued.id, event);
    console.log(JSON.stringify({ level: 'info', msg: 'phase2_outcome', correlationId, ...outcome }));
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'phase2_failed', correlationId,
      err: err instanceof Error ? err.message : String(err),
    }));
  }

  return 'sent';
}

export interface HouseholdRouting {
  /** The household that holds this Ring device (store/ringDevices.ts). */
  readonly householdOf: (ringDeviceId: string) => Promise<string | undefined>;
  readonly depsFor: (householdId: string) => RouteDeps;
}

/**
 * Whose doorbell rang, then the whole path for that household.
 *
 * A ring carries a Ring device id and nothing about a household (INV-8: no
 * household from an environment variable). A doorbell no household holds
 * reaches no television: showing one home a picture of another home's door
 * is the failure this refuses, so there is no default household to fall
 * back to.
 */
export async function routeDoorEvent(detail: Record<string, unknown>, routing: HouseholdRouting): Promise<RouteResult> {
  // Before the lookup, for the same reason routeRingEvent gates before its
  // own: most events on the bus are not doorbell events.
  if (!isDoorWorthy(detail)) return 'skipped';

  const { deviceId } = toRingHistoryEvent(detail, '');
  const householdId = await routing.householdOf(deviceId);
  if (!householdId) return 'unclaimed_device';

  return routeRingEvent(detail, routing.depsFor(householdId));
}
