/**
 * THE SINGLE EGRESS MODULE.  INV-2.
 *
 * This is the only module in the repository permitted to import a transport
 * client. Every other module calls sendToFamily() / sendToDevice(). An ESLint
 * no-restricted-imports rule enforces it — a rule you can run beats a convention
 * you can only remember.
 *
 * Why it matters beyond tidiness: prompt injection is a live threat here. A
 * visitor's clothing or signage lands inside a vision prompt, and a note from
 * the family is free text. Because the Guardian runs HERE — deterministically, after
 * generation, on typed classes — a model that gets talked into emitting a health
 * fact still cannot get it past the gate.
 *
 * See docs/WICK-TECHNICAL.md §6.3, §10.2.
 */
import { evaluate, type Audience, type HouseholdPolicy } from '@wick/policy';
import { MAX_CARD_ACTIONS, type Card, type CardPatch, type FactClass, type QueuedCard } from '@wick/contracts';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

export interface EgressItem {
  readonly class: FactClass;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly correlationId: string;
}

export type EgressResult =
  | { readonly sent: true; readonly content: string }
  | { readonly sent: false; readonly reason: string };

/**
 * The only path to a family surface.
 *
 * A Guardian that throws must fail CLOSED — refuse, alarm, and never fall
 * through to sending. See §11.
 *
 * decision.transform names what evaluate() decided the content needs
 * ('summarise' or 'redact_specifics') but there is no implementation of
 * either transform yet — no product decision exists on what "summarise a
 * RHYTHM fact" concretely does to a string. Sending item.content through
 * untransformed in that case would silently defeat the exact policy that
 * required it: an audience gets the raw content the household's table
 * marked as needing narrowing first. So this refuses instead — fail
 * closed, same as an evaluate() throw — until a real transform exists.
 * Every class the default policy marks `allow` with no transform (most of
 * DOOR_EVENT/PRESENCE) is unaffected and sends today.
 */
export async function sendToFamily(
  item: EgressItem,
  audience: Extract<Audience, 'FAMILY' | 'AGENCY'>,
  policy: HouseholdPolicy,
): Promise<EgressResult> {
  let decision;
  try {
    decision = evaluate(item, audience, policy);
  } catch {
    // Fail closed. Emit guardian.error; the alarm is wired in infra/.
    return { sent: false, reason: 'Unable to share that right now.' };
  }

  const logDecision = (allow: boolean, reason: string): void => {
    // §11: class, audience, allow, transform, reason — never item.content.
    console.log(JSON.stringify({
      level: 'info', msg: 'guardian_decision',
      class: item.class, audience, allow, transform: decision.transform, reason,
    }));
  };

  if (!decision.allow) {
    logDecision(false, decision.reason);
    return { sent: false, reason: decision.reason };
  }

  if (decision.transform) {
    const reason = `transform "${decision.transform}" is not yet implemented`;
    logDecision(false, reason);
    return { sent: false, reason: 'Unable to share that right now.' };
  }

  logDecision(true, decision.reason);
  return { sent: true, content: item.content };
}

interface DeviceConnection {
  readonly connectionId: string;
  readonly wsEndpoint: string;
  readonly deviceSk: string;
}

/**
 * Every live WebSocket connection among a household's DEV# items. Pure, so
 * the selection is tested without AWS.
 *
 * All of them, never "the first": this used to Query with `Limit: 1`, and
 * DynamoDB returns DEV# keys in sort order — so a household that had ever
 * paired a second device (the ops console's virtual TV, 'ops-console-…',
 * sorts before 'wick-tv') resolved to that disconnected device, and every
 * live push silently fell through to "offline". A door card also belongs on
 * every television in the house, not one of them.
 */
export function liveDeviceConnections(items: readonly Record<string, AttributeValue>[]): DeviceConnection[] {
  const live: DeviceConnection[] = [];
  for (const item of items) {
    const connectionId = item.connectionId?.S;
    const wsEndpoint = item.wsEndpoint?.S;
    const deviceSk = item.sk?.S;
    // Offline, or on the MQTT path — IoT Core publish isn't wired up yet
    // (SP-5 gate, see FRICTION.md FL-009).
    if (!connectionId || item.transport?.S !== 'websocket' || !wsEndpoint || !deviceSk) continue;
    live.push({ connectionId, wsEndpoint, deviceSk });
  }
  return live;
}

async function findDeviceConnections(householdId: string): Promise<DeviceConnection[]> {
  const items: Record<string, AttributeValue>[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: `HH#${householdId}` },
        ':prefix': { S: 'DEV#' },
      },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return liveDeviceConnections(items);
}

/**
 * One push per live device. Every device is attempted even if another
 * fails, then the first real failure is rethrown — one broken television
 * must not keep a card off the others.
 */
async function pushToDevices(householdId: string, payload: unknown): Promise<void> {
  const conns = await findDeviceConnections(householdId);
  const results = await Promise.allSettled(conns.map((conn) => pushOverWebSocket(householdId, conn, payload)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * Push one payload over an open connection, cleaning up a stale one rather
 * than surfacing GoneException to the caller — the payload was already
 * durable in DynamoDB (the CARD# item, or the patched CARD# item) before this
 * runs, so a dead connection here is a missed live push, not a lost update.
 */
async function pushOverWebSocket(
  householdId: string,
  conn: DeviceConnection,
  payload: unknown,
): Promise<void> {
  const mgmt = new ApiGatewayManagementApiClient({ endpoint: conn.wsEndpoint });
  try {
    await mgmt.send(new PostToConnectionCommand({
      ConnectionId: conn.connectionId,
      Data: JSON.stringify(payload),
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'GoneException') {
      // Guard on connectionId, same as disconnect.mjs: a stale
      // PostToConnection can throw GoneException after the device has
      // already reconnected (fresh connectionId written by connect.mjs in
      // the gap between the earlier Query and this catch). An unconditional
      // REMOVE here would wipe out the live connection.
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: `HH#${householdId}` }, sk: { S: conn.deviceSk } },
          UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint, connectedAt',
          ConditionExpression: 'connectionId = :cid',
          ExpressionAttributeValues: { ':cid': { S: conn.connectionId } },
        }));
      } catch (cleanupErr) {
        if ((cleanupErr as { name?: string }).name !== 'ConditionalCheckFailedException') throw cleanupErr;
      }
      return;
    }
    throw err;
  }
}

/**
 * Attributes that live on the CARD# item for the agent plane's own use and
 * are never part of the card the device receives. Today: which Ring camera
 * the card came from, so Watch live (M2) can open that camera's stream
 * without the television ever holding a Ring identifier.
 */
export interface ServerOnly {
  readonly ringDeviceId?: string;
}

/** The CARD# queue item. Pure, so its shape is tested without AWS. */
export function cardItem(card: QueuedCard, serverOnly: ServerOnly = {}): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {
    pk: { S: `HH#${card.card.householdId}` },
    sk: { S: `CARD#${card.id}` },
    data: { S: JSON.stringify(card) },
  };
  if (card.expiresAt !== undefined) {
    item.ttl = { N: String(Math.floor(card.expiresAt / 1000)) };
  }
  if (serverOnly.ringDeviceId) item.ringDeviceId = { S: serverOnly.ringDeviceId };
  return item;
}

/**
 * The only path to the television.
 *
 * The resident is always audience RESIDENT, so the Guardian is permissive here —
 * but it still runs, because "the resident sees everything about themselves" is a
 * policy decision, not an absence of policy.
 */
export async function sendToDevice(
  card: QueuedCard,
  _policy: HouseholdPolicy,
  serverOnly: ServerOnly = {},
): Promise<void> {
  const householdId = card.card.householdId;

  // The Card item is the queue's source of truth — written unconditionally,
  // before any attempt at a live push, so connect.mjs's reconcile step can
  // always deliver it later even if the device is offline right now.
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: cardItem(card, serverOnly) }));

  // No live device: reconcile delivers it the moment one is next seen.
  await pushToDevices(householdId, { kind: 'card', card });
}

/**
 * Phase 2 (§5.2, §9.1) — merge a patch into the card a stored QueuedCard
 * already carries. Pure: no I/O, so it is fully covered by
 * egress.test.ts without touching AWS. Mirrors QueueStore.applyPatch's
 * device-side merge exactly, so a reconnecting device replaying its CARD#
 * backlog (route.mjs's reconcile) sees the same merged card a live push
 * would have delivered.
 */
export function applyCardPatch(card: Card, patch: CardPatch): Card {
  if (card.type !== 'DOOR' || card.id !== patch.cardId) return card;
  return {
    ...card,
    ...(patch.line === undefined ? {} : { line: patch.line }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.imageRef === undefined ? {} : { imageRef: patch.imageRef }),
    ...(patch.match === undefined ? {} : { match: patch.match }),
    ...(patch.notice === undefined ? {} : { notice: patch.notice }),
    ...(patch.actions === undefined ? {} : { actions: patch.actions.slice(0, MAX_CARD_ACTIONS) }),
  };
}

/**
 * The only path to a Phase 2 patch. No-ops when there is nothing stored to
 * patch — the card was never queued, or (P0) has already aged out — rather
 * than writing a patch with no card underneath it.
 */
export async function sendPatchToDevice(patch: CardPatch, householdId: string): Promise<void> {
  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${patch.cardId}` } },
  }));
  if (!existing.Item?.data?.S) return;

  const stored = JSON.parse(existing.Item.data.S) as QueuedCard;
  const patched: QueuedCard = { ...stored, card: applyCardPatch(stored.card, patch) };

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${patch.cardId}` } },
    UpdateExpression: 'SET #data = :data',
    ExpressionAttributeNames: { '#data': 'data' },
    ExpressionAttributeValues: { ':data': { S: JSON.stringify(patched) } },
  }));

  // No live device: reconcile replays the patched CARD# item on next connect.
  await pushToDevices(householdId, { kind: 'control', control: { t: 'patch', patch } });
}
