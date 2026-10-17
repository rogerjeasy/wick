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
import type { CachedDevices, RingClient } from '@wick/ring';
import {
  cachedDevices,
  hasHallwayChime,
  imageForEvent,
  listDevices,
  playableChimes,
  ringClientsByHousehold,
} from '@wick/ring';
import { DEMO_DOOR_SOURCE, type RosterEntry, type VisitorMatch } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { stillWelcome } from './roster.js';
import { cachedRoster } from './rosterCache.js';
import { buildDoorEventItem, buildPresenceItem } from './presence.js';
import { noteDoorSighting } from '../visit/note.js';
import { visitStore, type VisitSend } from '../../store/visits.js';
import { runDoorPhase2, withinDeadline } from './phase2.js';
import { describeViaRuntime } from './describeRemote.js';
import { routeDoorEvent, type RouteDeps, type RouteResult } from './route.js';
import { routeDemoDoorEvent, standInPictures, type StandInBase } from './demoDoor.js';
import { announceRings } from './announce.js';
import { isDemoHome } from '../../store/household.js';
import { agentCoreTarget, invokeRuntime, type RuntimeTarget } from '../../runtime/invoke.js';
import { sendToDevice as realSendToDevice, sendPatchToDevice as realSendPatchToDevice } from '../../egress.js';
import { createRhythmWriter } from '../../rhythm/writeClient.js';
import { devicesOfHousehold, ringDeviceOwners, type DdbSend } from '../../store/ringDevices.js';
import { lookStore, type LookSend } from '../../store/looks.js';
import { buildDoorActivityKey, buildPresenceKey } from '../../rhythm/records.js';

// The path itself lives in route.ts; it is exported from here as it always was.
export { routeDoorEvent, routeRingEvent, type HouseholdRouting, type RouteDeps, type RouteResult } from './route.js';

interface EventBridgeEnvelope {
  /** `wick.ring` from the bus; `wick.demo-door` from the Wick server's own invoke (demoDoor.ts). */
  readonly source?: string;
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

/*
 * The door Lambda's time, spent in order (its timeout is 40 s, infra/agent.tf):
 *   Phase 1   the device list, if not cached: one Ring call, 5 s at most
 *             (RING_REQUEST_TIMEOUT_MS), then the table and the push.
 *   Phase 2a  the frame: FRAME_DEADLINE_MS for every attempt together. A
 *             frame takes about 3 s, and FL-008's settling retries wait 2 s
 *             between attempts, so three refusals and a success fit.
 *   Phase 2b  the sentence: DESCRIBE_DEADLINE_MS for the agent plane,
 *             a cold session included. A later sentence is worse than none.
 * 5 + 14 + 8 = 27 s, with the table, the push and a cold start inside the rest.
 */
const FRAME_DEADLINE_MS = 14_000;
const DESCRIBE_DEADLINE_MS = 8_000;
/** The agent plane, held to the door's own deadline rather than the default. */
const doorAgents = (): RuntimeTarget => ({ ...agentCoreTarget(), timeoutMs: DESCRIBE_DEADLINE_MS });

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
/** The household's clock (infra/agent.tf): a regular visitor's "09:00" is read on it. */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';
// S6. Same table, same client — see rhythm/records.ts's header for why this
// is DynamoDB rather than Timestream.
const rhythmWriter = createRhythmWriter(ddb, TABLE);
const ringDevices = ringDeviceOwners((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);
const visits = visitStore((cmd) => ddb.send(cmd as never) as ReturnType<VisitSend>, TABLE);

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

// Every ring is said on the Wick bus (announce.ts), for a visit errand waiting at the door (infra/errands.tf).
const events = new EventBridgeClient({});
const announceRing = announceRings((entries) => events.send(new PutEventsCommand({ Entries: [...entries] })), process.env.EVENT_BUS_NAME || undefined);

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

/**
 * A Ring doorbell, or a demo home's stand-in (demoDoor.ts). The stand-in's
 * source is the only thing that takes the other path, and nothing but the
 * Wick server's role can invoke this function with it (infra/agent.tf): the
 * EventBridge rule that also invokes it passes `wick.ring` events and no
 * others. Whatever a detail says, it goes where its source sends it.
 */
export async function dispatchDoorEvent<R>(
  evt: { readonly source?: unknown; readonly detail: Record<string, unknown> },
  routes: { readonly ring: (detail: Record<string, unknown>) => Promise<R>; readonly demo: (detail: Record<string, unknown>) => Promise<R> },
): Promise<R> {
  return evt.source === DEMO_DOOR_SOURCE ? routes.demo(evt.detail) : routes.ring(evt.detail);
}

/** The stand-in pictures, copied beside this bundle by scripts/build-lambda.mjs. */
const STAND_IN_PICTURES = new URL('./demo-door/', import.meta.url);

/** The stand-in doorbell's composition: the table, the television and the agent plane, and no Ring at all. */
function standInBase(): StandInBase {
  const agents = (runtime ??= doorAgents());
  return {
    put: async (item) => void (await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }))),
    rhythm: createRhythmWriter(ddb, TABLE, { simulated: true }),
    visits,
    listRoster: fetchRoster,
    listFamily: fetchFamily,
    // No Ring device beside the card: there is nothing for Watch live to open.
    sendToDevice: (card) => realSendToDevice(card, DEFAULT_POLICY),
    sendPatch: realSendPatchToDevice,
    describe: (householdId) => describeViaRuntime((kind, hh, payload) => invokeRuntime(agents, kind, hh, payload), householdId),
    pictures: standInPictures(STAND_IN_PICTURES),
    announceRing,
    newId: randomUUID,
    now: Date.now,
    timeZone: HOUSEHOLD_TZ,
  };
}

export const handler = async (evt: EventBridgeEnvelope): Promise<void> => {
  const result = await dispatchDoorEvent(evt, {
    ring: routeRing,
    demo: (detail) => routeDemoDoorEvent(detail, { isDemoHome: (householdId) => isDemoHome(ddb, TABLE, householdId), base: standInBase() }),
  });
  const quiet = result === 'sent' || result === 'skipped';
  console.log(JSON.stringify({ level: quiet ? 'info' : 'warn', msg: 'door_event_routed', source: evt.source === DEMO_DOOR_SOURCE ? DEMO_DOOR_SOURCE : 'wick.ring', result }));
};

async function routeRing(detail: Record<string, unknown>): Promise<RouteResult> {
  const agents = (runtime ??= doorAgents());

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
      noteSighting: async (match, at) => void (await noteDoorSighting({ householdId, match, at }, visits)),
      sendToDevice: (card, ringDeviceId) => realSendToDevice(card, DEFAULT_POLICY, { ringDeviceId }),
      runPhase2: (cardId, event) =>
        runDoorPhase2(cardId, {
          fetchImage: withinDeadline(() => imageForEvent(ringClient, event.deviceId, event), FRAME_DEADLINE_MS, 'frame_deadline'),
          describe,
          sendPatch: (patch) => realSendPatchToDevice(patch, householdId),
        }, event.eventType),
      announceRing,
      now: Date.now,
      timeZone: HOUSEHOLD_TZ,
    };
  };

  return routeDoorEvent(detail, { householdOf: ringDevices.householdOf, depsFor });
}
