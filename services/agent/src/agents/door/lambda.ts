/**
 * EventBridge entrypoint — a `wick.ring` event becomes a real card on the
 * device. The composition root for S1's whole path:
 *
 *   webhook.mjs -> EventBridge "wick" bus -> (this)
 *     -> Phase 1: handleDoorEvent -> sendToDevice
 *     -> Phase 2: runDoorPhase2  -> sendPatchToDevice
 *
 * `routeRingEvent` is the part worth unit testing — gating, device lookup,
 * error propagation — with every AWS/Bedrock client injected behind
 * `runPhase2`. `handler` is the thin shim that wires the real ones, in the
 * same style as webhook.mjs and connect.mjs: composition, not logic, so it
 * is left untested the same way those are.
 *
 * Phase 2 runs to completion (or its own internal timeout — describe.ts's
 * DESCRIBE_TIMEOUT_MS) before this handler returns: Lambda freezes the
 * execution environment the instant the handler's promise resolves, so
 * there is no such thing as "fire and forget" background work here. A
 * Phase 2 failure is caught rather than propagated — Phase 1 already
 * reached the device by the time Phase 2 runs, and losing the picture or
 * the sentence is not a reason to fail the whole invocation (and risk an
 * EventBridge retry re-running Phase 1 for no benefit).
 *
 * Household resolution is hardcoded to one household via WICK_HOUSEHOLD_ID.
 * There is no Ring-device -> household registry in this repo yet, and the
 * product is built around one real household (docs/WICK.md §2). Multi-
 * household is Tier 3 (§4.5), not S1 — do not build a registry for it here.
 */
import type { RingDevice, RingHistoryEvent } from '@wick/ring';
import {
  RingClient,
  cachedDeviceLookup,
  imageForEvent,
  listDevices,
  secretsManagerTokenProvider,
} from '@wick/ring';
import type { QueuedCard, RosterEntry, VisitorMatch } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { handleDoorEvent } from './handle.js';
import { isDoorWorthy, toRingHistoryEvent } from './parseEvent.js';
import { matchVisitor } from './roster.js';
import { buildDoorEventItem, buildPresenceItem } from './presence.js';
import { runDoorPhase2 } from './phase2.js';
import { describeFrame } from './describe.js';
import { sendToDevice as realSendToDevice, sendPatchToDevice as realSendPatchToDevice } from '../../egress.js';
import { createRhythmWriter } from '../../rhythm/writeClient.js';
import { buildDoorActivityKey, buildPresenceKey } from '../../rhythm/records.js';

export type RouteResult = 'sent' | 'skipped' | 'unknown_device';

export interface RouteDeps {
  readonly householdId: string;
  readonly findDevice: (deviceId: string) => Promise<RingDevice | undefined>;
  /** M4. Most households have not curated one; an empty list is the common answer. */
  readonly listRoster: () => Promise<readonly RosterEntry[]>;
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
  readonly sendToDevice: (card: QueuedCard) => Promise<void>;
  readonly runPhase2: (cardId: string, event: RingHistoryEvent) => Promise<void>;
  readonly now: () => number;
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

  const device = await deps.findDevice(event.deviceId);
  if (!device) return 'unknown_device';

  const roster = await deps.listRoster();

  const queued = await handleDoorEvent(
    { event, device, householdId: deps.householdId, correlationId, now: deps.now(), roster },
    { sendToDevice: deps.sendToDevice },
  );

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
    await deps.runPhase2(queued.id, event);
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'phase2_failed', correlationId,
      err: err instanceof Error ? err.message : String(err),
    }));
  }

  return 'sent';
}

interface EventBridgeEnvelope {
  readonly detail: Record<string, unknown>;
}

let lookupDevice: ((deviceId: string) => Promise<RingDevice | undefined>) | undefined;

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
// S6. Same table, same client — see rhythm/records.ts's header for why this
// is DynamoDB rather than Timestream.
const rhythmWriter = createRhythmWriter(ddb, TABLE);
const ROSTER_CACHE_MS = 60_000;
let rosterCache: { roster: readonly RosterEntry[]; fetchedAt: number } | undefined;

/**
 * M4's roster, container-cached like deviceCache.ts's device list — a
 * household curates this rarely, and Phase 1 shouldn't pay a DynamoDB round
 * trip on every warm invocation just to usually find nobody scheduled.
 */
async function fetchRoster(householdId: string): Promise<readonly RosterEntry[]> {
  if (rosterCache && Date.now() - rosterCache.fetchedAt < ROSTER_CACHE_MS) return rosterCache.roster;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: 'PER#' },
    },
  }));
  const roster = (res.Items ?? [])
    .map((item) => item.data?.S)
    .filter((s): s is string => Boolean(s))
    .map((s) => JSON.parse(s) as RosterEntry);

  rosterCache = { roster, fetchedAt: Date.now() };
  return roster;
}

async function recordPresence(householdId: string, match: VisitorMatch, at: number): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: buildPresenceItem(householdId, match, at, randomUUID()),
  }));
}

async function recordDoorEvent(householdId: string, at: number): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: buildDoorEventItem(householdId, at, randomUUID()),
  }));
}

async function recordDoorActivity(
  householdId: string,
  deviceId: string,
  subType: string,
  measureName: 'motion' | 'button_press',
  at: number,
): Promise<void> {
  const key = buildDoorActivityKey({ householdId, deviceId, subType, measureName, at });
  await rhythmWriter.increment(key, at);
}

async function recordPresenceActivity(householdId: string, personId: string, at: number): Promise<void> {
  const key = buildPresenceKey({ householdId, personId, measureName: 'arrival', at });
  await rhythmWriter.increment(key, at);
}

export const handler = async (evt: EventBridgeEnvelope): Promise<void> => {
  const householdId = process.env.WICK_HOUSEHOLD_ID;
  if (!householdId) throw new Error('WICK_HOUSEHOLD_ID not set');

  const ringClient = new RingClient({ getToken: secretsManagerTokenProvider() });
  lookupDevice ??= cachedDeviceLookup({ list: () => listDevices(ringClient) });

  const result = await routeRingEvent(evt.detail, {
    householdId,
    findDevice: lookupDevice,
    listRoster: () => fetchRoster(householdId),
    recordPresence: (match, at) => recordPresence(householdId, match, at),
    recordDoorEvent: (at) => recordDoorEvent(householdId, at),
    recordDoorActivity: (deviceId, subType, measureName, at) =>
      recordDoorActivity(householdId, deviceId, subType, measureName, at),
    recordPresenceActivity: (personId, at) => recordPresenceActivity(householdId, personId, at),
    sendToDevice: (card) => realSendToDevice(card, DEFAULT_POLICY),
    runPhase2: (cardId, event) =>
      runDoorPhase2(cardId, {
        fetchImage: () => imageForEvent(ringClient, event.deviceId, event),
        describe: (bytes) => describeFrame(bytes),
        sendPatch: (patch) => realSendPatchToDevice(patch, householdId),
      }),
    now: Date.now,
  });

  console.log(JSON.stringify({ level: 'info', msg: 'door_event_routed', result }));
};
