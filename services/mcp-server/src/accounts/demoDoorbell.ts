/**
 * POST /api/demo/doorbell — the stand-in doorbell of a demo home
 * (packages/contracts demoDoor.ts).
 *
 * A guest's demo home has no Ring doorbell, so whoever tries Wick would
 * never see the door card on the resident's television. Here a member of a
 * demo home makes one of a fixed list of stand-in visitors arrive; the Door
 * agent then takes it through its own path (services/agent agents/door/
 * demoDoor.ts). This server decides who may ring and how often, and hands
 * the agent the ring. It never reaches Ring.
 *
 * The checks, in the order they are made:
 *
 *   1. Who is ringing: a member the resident has allowed, asked afresh
 *      (INV-9), and not a neighbour — who is asked to look at the door, and
 *      makes nothing happen at it.
 *   2. That the household is a demo home (`simulated`, accounts/demo.ts).
 *      A home a person set up has its own door, and nobody is to be shown a
 *      stand-in at it.
 *   3. That this Wick can ring the Door agent at all.
 *   4. That the visitor is one of the fixed list.
 *   5. Whether this very ring was made already (the `Idempotency-Key` the
 *      app made for it, INV-6): it is answered as it was.
 *   6. That her television is connected: there is nowhere else for a door
 *      card to go.
 *   7. That the door has not just rung (DEMO_DOOR_COOLDOWN_MS): a double
 *      click is one ring.
 *   8. That the home has not rung DEMO_DOOR_RINGS_PER_HOUR times this hour:
 *      each ring wakes the agent plane and a vision model.
 *
 * 7 and 8 are each one conditional write, so rings that cross cannot get
 * past either. Then the ring's id is claimed, and the agent is invoked.
 *
 * INV-8: the household is the one in the caller's token. The body names a
 * visitor and nothing else is read from it; one header is read, the
 * `Idempotency-Key`.
 */
import { DeleteItemCommand, GetItemCommand, PutItemCommand, UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { isDemoRingId, isDemoVisitorKey, type DemoDoorEvent, type DemoVisitorKey } from '@wick/contracts';
import { accessOf } from './circle.js';
import type { AccountStore } from './store.js';

export type { DemoDoorEvent } from '@wick/contracts';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** A double click, or a second press before the first card is up: one ring. */
export const DEMO_DOOR_COOLDOWN_MS = 20_000;
/** Enough to try every visitor a few times; too few to make the door, or the agent plane, a toy. */
export const DEMO_DOOR_RINGS_PER_HOUR = 10;

const HOUR_MS = 60 * 60_000;
/** The count of an hour, and the record of a ring, are let go of by the table a day on. */
const KEPT_FOR_MS = 24 * HOUR_MS;

const LAST_SK = 'DEMODOOR#LAST';
const HOUR_SK_PREFIX = 'TRY#DEMODOOR#';
const RING_SK_PREFIX = 'DEMODOOR#RING#';

export interface DemoDoorbellDeps {
  readonly ddb: DynamoDBClient;
  readonly store: AccountStore;
  /** Hands the ring to the Door agent (index.ts: invokes it). Absent, the stand-in doorbell is refused in words. */
  readonly ring?: ((event: DemoDoorEvent) => Promise<void>) | undefined;
  readonly now: () => number;
  /** A fresh, unguessable, URL-safe id. */
  readonly newId: () => string;
}

export type DemoDoorRefusalCode =
  | 'not_allowed_yet'
  | 'not_for_a_neighbour'
  | 'not_a_demo_home'
  | 'doorbell_unavailable'
  | 'bad_visitor'
  | 'bad_key'
  | 'key_in_use'
  | 'no_television'
  | 'too_soon'
  | 'too_many'
  | 'not_rung';

export class DemoDoorRefusal extends Error {
  readonly status: number;
  readonly code: DemoDoorRefusalCode;
  constructor(status: number, code: DemoDoorRefusalCode, message: string) {
    super(message);
    this.name = 'DemoDoorRefusal';
    this.status = status;
    this.code = code;
  }
}

export interface DemoDoorRung {
  readonly rung: true;
  readonly visitor: DemoVisitorKey;
  readonly say: string;
}

/** Who is ringing: the person and household their access token names (INV-8). */
export interface DemoDoorActor {
  readonly householdId: string;
  readonly userId: string;
}

const conditionFailed = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';
const ttlOf = (at: number): string => String(Math.floor((at + KEPT_FOR_MS) / 1000));
const hourOf = (at: number): string => new Date(at).toISOString().slice(0, 13);

export async function ringDemoDoorbell(deps: DemoDoorbellDeps, actor: DemoDoorActor, body: unknown, key: string | undefined): Promise<DemoDoorRung> {
  const [membership, household] = await Promise.all([
    deps.store.getMembership(actor.householdId, actor.userId),
    deps.store.getHousehold(actor.householdId),
  ]);
  if (membership?.role === 'neighbour') throw new DemoDoorRefusal(403, 'not_for_a_neighbour', 'A neighbour cannot ring the stand-in doorbell.');
  const access = accessOf(membership, household);
  if (!access.ok) throw new DemoDoorRefusal(403, 'not_allowed_yet', access.say);
  const resident = access.household.residentName;
  if (access.household.simulated !== true) {
    throw new DemoDoorRefusal(403, 'not_a_demo_home', `The stand-in doorbell is only for a demo home. ${resident}’s door is her own.`);
  }
  if (!deps.ring) throw new DemoDoorRefusal(503, 'doorbell_unavailable', 'This Wick has no stand-in doorbell yet.');

  const visitor = (body as { visitor?: unknown } | undefined)?.visitor;
  if (!isDemoVisitorKey(visitor)) throw new DemoDoorRefusal(400, 'bad_visitor', 'Choose who is at the door.');
  // A key that is not shaped like one is refused, not ignored: ringing without it would give up "once".
  if (key !== undefined && !isDemoRingId(key)) throw new DemoDoorRefusal(400, 'bad_key', 'That ring could not be sent. Try again.');

  const rung: DemoDoorRung = { rung: true, visitor, say: `${resident}’s television will show who is at the door. Answer it there.` };
  const pk = { S: `HH#${actor.householdId}` };

  /** This ring was made already: the ringer's own is answered as it was; anybody else's key is not theirs. */
  const alreadyRung = async (ringId: string): Promise<DemoDoorRung | undefined> => {
    const row = (await deps.ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk, sk: { S: `${RING_SK_PREFIX}${ringId}` } }, ConsistentRead: true }))).Item;
    if (!row) return undefined;
    if (row.userId?.S !== actor.userId) throw new DemoDoorRefusal(409, 'key_in_use', 'That ring could not be sent. Try again.');
    return isDemoVisitorKey(row.visitor?.S) ? { ...rung, visitor: row.visitor.S } : rung;
  };
  if (key !== undefined) {
    const before = await alreadyRung(key);
    if (before) return before;
  }

  if ((await deps.store.listTelevisions(actor.householdId)).length === 0) {
    throw new DemoDoorRefusal(409, 'no_television', `Connect ${resident}’s television first. The door card is shown there.`);
  }

  const now = deps.now();
  try {
    await deps.ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk, sk: { S: LAST_SK } },
      UpdateExpression: 'SET #at = :now, #ttl = :ttl',
      ConditionExpression: '(attribute_not_exists(#at) OR #at <= :since)',
      ExpressionAttributeNames: { '#at': 'at', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':now': { N: String(now) }, ':since': { N: String(now - DEMO_DOOR_COOLDOWN_MS) }, ':ttl': { N: ttlOf(now) } },
    }));
  } catch (err) {
    if (conditionFailed(err)) throw new DemoDoorRefusal(429, 'too_soon', `The doorbell has only just rung. Give ${resident}’s television a moment, then ring again.`);
    throw err;
  }

  try {
    await deps.ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk, sk: { S: `${HOUR_SK_PREFIX}${hourOf(now)}` } },
      UpdateExpression: 'ADD #rings :one SET #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: '(attribute_not_exists(#rings) OR #rings < :cap)',
      ExpressionAttributeNames: { '#rings': 'rings', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':cap': { N: String(DEMO_DOOR_RINGS_PER_HOUR) }, ':ttl': { N: ttlOf(now) } },
    }));
  } catch (err) {
    if (conditionFailed(err)) throw new DemoDoorRefusal(429, 'too_many', 'That is enough rings at the door for this hour. You can ring again later.');
    throw err;
  }

  const ringId = key ?? deps.newId();
  const ringKey = { pk, sk: { S: `${RING_SK_PREFIX}${ringId}` } };
  try {
    await deps.ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { ...ringKey, userId: { S: actor.userId }, visitor: { S: visitor }, at: { N: String(now) }, ttl: { N: ttlOf(now) } },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err) {
    if (!conditionFailed(err)) throw err;
    // Another try with this key got there first: that one is the ring.
    const other = await alreadyRung(ringId);
    if (other) return other;
    throw new DemoDoorRefusal(409, 'key_in_use', 'That ring could not be sent. Try again.');
  }

  try {
    await deps.ring({ householdId: actor.householdId, visitor, ringId, occurredAt: now, correlationId: deps.newId() });
  } catch (err) {
    // The error's name only. The ring is let go of, so the same press can try again.
    console.error(JSON.stringify({ level: 'error', msg: 'demo_door_not_rung', err: err instanceof Error ? err.name : 'unknown' }));
    await deps.ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: ringKey })).catch(() => undefined);
    throw new DemoDoorRefusal(502, 'not_rung', 'The doorbell could not be rung just now. Try again in a moment.');
  }
  return rung;
}
