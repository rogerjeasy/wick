/**
 * EventBridge entrypoint — a `wick.ring` event becomes a real card on the
 * device. The composition root for S1's whole path:
 *
 *   webhook.mjs -> EventBridge "wick" bus -> (this)
 *     -> Phase 1: handleDoorEvent -> sendToDevice
 *     -> Phase 2: runDoorPhase2  -> sendPatchToDevice
 *          (2b, the sentence, runs in the household's AgentCore Runtime
 *          session as a Strands graph — describeRemote.ts)
 *
 * `routeDoorEvent` and `routeRingEvent` are the parts worth unit testing —
 * whose doorbell it is, gating, device lookup, error propagation — with
 * every AWS/Bedrock client injected behind `depsFor` and `runPhase2`.
 * `handler` is the thin shim that wires the real ones, in the
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
 * The household comes from the doorbell that rang (store/ringDevices.ts),
 * never from an environment variable (AGENTS.md INV-8). Each household has
 * its own Ring link: connecting it claims the doorbells that link can see
 * (services/edge-ring/lambda/household-link-service.mjs), and a device nobody
 * holds reaches nobody.
 */
import type { CachedDevices, RingClient, RingDevice, RingHistoryEvent } from '@wick/ring';
import {
  cachedDevices,
  hasHallwayChime,
  imageForEvent,
  listDevices,
  playableChimes,
  ringClientsByHousehold,
} from '@wick/ring';
import type { QueuedCard, RosterEntry, VisitorMatch } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { handleDoorEvent } from './handle.js';
import { isDoorWorthy, toRingHistoryEvent } from './parseEvent.js';
import { matchVisitor, stillWelcome } from './roster.js';
import { cachedRoster } from './rosterCache.js';
import { buildDoorEventItem, buildPresenceItem } from './presence.js';
import { runDoorPhase2, type Phase2Outcome } from './phase2.js';
import { describeViaRuntime } from './describeRemote.js';
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../../runtime/invoke.js';
import { sendToDevice as realSendToDevice, sendPatchToDevice as realSendPatchToDevice } from '../../egress.js';
import { createRhythmWriter } from '../../rhythm/writeClient.js';
import { devicesOfHousehold, ringDeviceOwners, type DdbSend } from '../../store/ringDevices.js';
import { lookStore, type LookSend } from '../../store/looks.js';
import { buildDoorActivityKey, buildPresenceKey } from '../../rhythm/records.js';

export type RouteResult = 'sent' | 'skipped' | 'unknown_device' | 'unclaimed_device';

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
  readonly sendToDevice: (card: QueuedCard, ringDeviceId: string) => Promise<void>;
  readonly runPhase2: (cardId: string, event: RingHistoryEvent) => Promise<Phase2Outcome>;
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
  // A failed lookup costs the button, never the card.
  const hallwayChime = await deps.hasHallwayChime().catch(() => false);
  const family = await deps.listFamily().catch(() => []);

  const queued = await handleDoorEvent(
    { event, device, hallwayChime, householdId: deps.householdId, correlationId, now: deps.now(), roster, family },
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

interface EventBridgeEnvelope {
  readonly detail: Record<string, unknown>;
}

/** One Ring client per household, each carrying that household's own token. */
const ringFor = ringClientsByHousehold();
/** The device list of each household's own link, cached as the single list used to be. */
const devicesByHousehold = new Map<string, CachedDevices>();
function devicesOf(householdId: string, client: RingClient): CachedDevices {
  let cached = devicesByHousehold.get(householdId);
  if (!cached) {
    cached = cachedDevices({ list: () => listDevices(client) });
    devicesByHousehold.set(householdId, cached);
  }
  return cached;
}
let runtime: RuntimeTarget | undefined;

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
// S6. Same table, same client — see rhythm/records.ts's header for why this
// is DynamoDB rather than Timestream.
const rhythmWriter = createRhythmWriter(ddb, TABLE);
const ringDevices = ringDeviceOwners((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);

async function loadRoster(householdId: string): Promise<readonly RosterEntry[]> {
  const rows = (prefix: string) => ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: prefix },
    },
  }));
  // The circle is read with the roster: a visit announced by someone since
  // removed must not be matched (roster.ts stillWelcome).
  const [people, members] = await Promise.all([rows('PER#'), rows('MEM#')]);
  const roster = (people.Items ?? [])
    .map((item) => item.data?.S)
    .filter((s): s is string => Boolean(s))
    .map((s) => JSON.parse(s) as RosterEntry);
  return stillWelcome(roster, members.Items ?? []);
}

const fetchRoster = cachedRoster({ load: loadRoster });

const looks = lookStore((cmd) => ddb.send(cmd as never) as ReturnType<LookSend>, TABLE);
const fetchFamily = cachedRoster<string>({
  load: async (householdId) => (await looks.listFamily(householdId)).map((member) => member.name),
});

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
  const agents = (runtime ??= agentCoreTarget());

  const depsFor = (householdId: string): RouteDeps => {
    // This household's own Ring link, and the devices it can see. A doorbell's
    // household was already settled from the doorbell (routeDoorEvent), so
    // the picture and the chime are asked for with that home's credential and
    // no other. Which of those devices the household holds is still
    // ringDevices' answer, never this list's: a credential can see a doorbell
    // another home holds.
    const ringClient = ringFor(householdId);
    const account = devicesOf(householdId, ringClient);
    const describe = describeViaRuntime((kind, hh, payload) => invokeRuntime(agents, kind, hh, payload), householdId);
    return {
      householdId,
      findDevice: account.find,
      // This household's own chime: the button must never sound in another home.
      hasHallwayChime: async () =>
        hasHallwayChime(await devicesOfHousehold(householdId, playableChimes(await account.all()), ringDevices.householdOf)),
      listRoster: () => fetchRoster(householdId),
      listFamily: () => fetchFamily(householdId),
      recordPresence: (match, at) => recordPresence(householdId, match, at),
      recordDoorEvent: (at) => recordDoorEvent(householdId, at),
      recordDoorActivity: (deviceId, subType, measureName, at) =>
        recordDoorActivity(householdId, deviceId, subType, measureName, at),
      recordPresenceActivity: (personId, at) => recordPresenceActivity(householdId, personId, at),
      sendToDevice: (card, ringDeviceId) => realSendToDevice(card, DEFAULT_POLICY, { ringDeviceId }),
      runPhase2: (cardId, event) =>
        runDoorPhase2(cardId, {
          fetchImage: () => imageForEvent(ringClient, event.deviceId, event),
          describe,
          sendPatch: (patch) => realSendPatchToDevice(patch, householdId),
        }, event.eventType),
      now: Date.now,
    };
  };

  const result = await routeDoorEvent(evt.detail, { householdOf: ringDevices.householdOf, depsFor });

  console.log(JSON.stringify({ level: result === 'unclaimed_device' ? 'warn' : 'info', msg: 'door_event_routed', result }));
};
