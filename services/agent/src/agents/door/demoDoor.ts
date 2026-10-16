/**
 * The stand-in doorbell of a demo home (packages/contracts demoDoor.ts):
 * somebody made to arrive at the door from the family app, taken through the
 * Door agent's own path.
 *
 *   family app -> POST /api/demo/doorbell (Wick server: who, which home, how often)
 *     -> this Lambda, invoked by the server's role alone (infra/agent.tf)
 *     -> routeDemoDoorEvent: is it a demo home? -> routeRingEvent (route.ts)
 *          Phase 1: the card, the roster, the timeline, the visit
 *          Phase 2: the stand-in picture -> the AgentCore describe graph -> the sentence
 *
 * What is stood in is Ring and only Ring: the doorbell (a device with no
 * camera to watch and no chime), and where the picture comes from (a file
 * made for the purpose, published at an https address the television loads,
 * and bundled beside this Lambda for the vision step). Everything after the
 * ring is the code a real ring runs. This module imports nothing of Ring's
 * but its types, and nothing it is given can reach Ring: there is no Ring
 * client in `StandInBase`.
 *
 * The household is the one the Wick server put in the event, from the
 * caller's verified token (INV-8); it is asked again here whether that
 * household is a demo home, and a ring for any other is dropped before
 * anything is read or written. Every row it writes carries `simulated`
 * (AGENTS.md, Data rules).
 */
import { readFile } from 'node:fs/promises';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { RingDevice } from '@wick/ring';
import { demoDoorEventOf, demoVisitor, type CardPatch, type DemoVisitor, type DoorRangDetail, type QueuedCard, type RosterEntry } from '@wick/contracts';
import { buildDoorEventItem, buildPresenceItem } from './presence.js';
import { runDoorPhase2 } from './phase2.js';
import { routeRingEvent, type RouteDeps, type RouteResult } from './route.js';
import type { DescribeResult } from './describe.js';
import { noteDoorSighting, type NoteDeps } from '../visit/note.js';
import { buildDoorActivityKey, buildPresenceKey } from '../../rhythm/records.js';
import type { RhythmWriter } from '../../rhythm/writeClient.js';

/** The stand-in doorbell's own id. Not a Ring id, and never stored beside a card: there is no camera to open. */
export const STAND_IN_DEVICE_ID = 'stand-in-doorbell';

const STAND_IN_DEVICE: RingDevice = {
  id: STAND_IN_DEVICE_ID,
  name: 'Front door (stand-in)',
  online: true,
  capabilities: { motion: true, image: true, chime: false },
};

/**
 * How late a ring may be handled. A ring is only true for a moment: one
 * delivered again minutes later (the Lambda's own retry) would put somebody
 * at the door who has gone.
 */
export const DEMO_EVENT_FRESH_MS = 2 * 60_000;

/** What the Lambda supplies: the table, the television, the agent plane — and no Ring. */
export interface StandInBase {
  readonly put: (item: Record<string, AttributeValue>) => Promise<void>;
  /** Made with `simulated` (rhythm/writeClient.ts). */
  readonly rhythm: RhythmWriter;
  readonly visits: NoteDeps;
  readonly listRoster: (householdId: string) => Promise<readonly RosterEntry[]>;
  readonly listFamily: (householdId: string) => Promise<readonly string[]>;
  /** egress.ts sendToDevice, with no Ring device beside the card. */
  readonly sendToDevice: (card: QueuedCard) => Promise<void>;
  readonly sendPatch: (patch: CardPatch, householdId: string) => Promise<void>;
  /** The household's describe step: the same AgentCore graph a real ring's picture goes to (describeRemote.ts). */
  readonly describe: (householdId: string) => (bytes: Uint8Array) => Promise<DescribeResult>;
  readonly pictures: (visitor: DemoVisitor) => Promise<Uint8Array>;
  /** The door says on the bus that it rang (announce.ts), as a real doorbell does: an arranged visit hears it. */
  readonly announceRing?: (detail: DoorRangDetail) => Promise<void>;
  readonly newId: () => string;
  readonly now: () => number;
}

/** Reads a stand-in visitor's picture from a directory: docs/demo-door, copied beside the bundle (scripts/build-lambda.mjs). */
export function standInPictures(directory: URL): (visitor: DemoVisitor) => Promise<Uint8Array> {
  return async (visitor) => new Uint8Array(await readFile(new URL(visitor.picture, directory)));
}

/** The door path's dependencies for one stand-in ring: Ring's parts stood in, every row marked simulated. */
export function standInRouteDeps(householdId: string, visitor: DemoVisitor, base: StandInBase): RouteDeps {
  const marked = { simulated: true } as const;
  const describe = base.describe(householdId);
  return {
    householdId,
    standIn: true,
    findDevice: async (deviceId) => (deviceId === STAND_IN_DEVICE_ID ? STAND_IN_DEVICE : undefined),
    hasHallwayChime: async () => false,
    listRoster: () => base.listRoster(householdId),
    listFamily: () => base.listFamily(householdId),
    recordPresence: (match, at) => base.put(buildPresenceItem(householdId, match, at, base.newId(), marked)),
    recordDoorEvent: (at) => base.put(buildDoorEventItem(householdId, at, base.newId(), marked)),
    recordDoorActivity: (deviceId, subType, measureName, at) =>
      base.rhythm.increment(buildDoorActivityKey({ householdId, deviceId, subType, measureName, at }), at),
    recordPresenceActivity: (personId, at) =>
      base.rhythm.increment(buildPresenceKey({ householdId, personId, measureName: 'arrival', at }), at),
    noteSighting: async (match, at) =>
      void (await noteDoorSighting({ householdId, match, at }, { ...base.visits, open: (visit) => base.visits.open({ ...visit, simulated: true }) })),
    sendToDevice: (card) => base.sendToDevice(card),
    runPhase2: (cardId, event) =>
      runDoorPhase2(cardId, {
        fetchImage: async () => ({
          image: { url: visitor.pictureUrl, capturedAt: event.start, fetchedAt: base.now() },
          bytes: await base.pictures(visitor),
        }),
        describe,
        sendPatch: (patch) => base.sendPatch(patch, householdId),
      }, event.eventType, { standIn: true }),
    ...(base.announceRing ? { announceRing: base.announceRing } : {}),
    now: base.now,
  };
}

export interface DemoRouting {
  /** Whether the household is a demo home: its META row carries `simulated` (services/mcp-server accounts/store.ts). */
  readonly isDemoHome: (householdId: string) => Promise<boolean>;
  readonly base: StandInBase;
}

export type DemoRouteResult = RouteResult | 'malformed' | 'stale' | 'not_a_demo_home';

export async function routeDemoDoorEvent(detail: unknown, routing: DemoRouting): Promise<DemoRouteResult> {
  const ring = demoDoorEventOf(detail);
  if (!ring) return 'malformed';
  if (routing.base.now() - ring.occurredAt > DEMO_EVENT_FRESH_MS) return 'stale';
  if (!(await routing.isDemoHome(ring.householdId))) return 'not_a_demo_home';

  const visitor = demoVisitor(ring.visitor);
  // The shape a Ring webhook puts on the bus (parseEvent.ts), so the path that follows is the real one.
  // The request id is the ring's: delivered twice, it is the same card (INV-6).
  const ringShaped: Record<string, unknown> = {
    request_id: `demo-${ring.ringId}`,
    event_type: visitor.eventType,
    ...(visitor.subType ? { sub_type: visitor.subType } : {}),
    device_id: STAND_IN_DEVICE_ID,
    occurred_at: ring.occurredAt,
    correlationId: ring.correlationId,
  };
  return routeRingEvent(ringShaped, standInRouteDeps(ring.householdId, visitor, routing.base));
}
