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
import { MAX_CARD_ACTIONS, PUSH_SK_PREFIX, type Card, type CardPatch, type DeviceWireMessage, type FactClass, type PushKind, type QueuedCard } from '@wick/contracts';
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import webpush from 'web-push';
import { nudge, subscriptionFromItem, type NudgeOutcome, type StoredSubscription } from './push/nudge.js';

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

/** A television on the API Gateway WebSocket. */
interface WebSocketConnection {
  readonly connectionId: string;
  readonly wsEndpoint: string;
  readonly deviceSk: string;
  /** Present only for the card service's connection — see liveDeviceConnections. */
  readonly background?: true;
}

/**
 * A television on MQTT over IoT Core. It is reached by publishing to its own
 * topics, so what is needed is its id; the session id is kept to say which
 * connection this was (edge-device's iot-presence.mjs writes both).
 */
interface MqttConnection {
  readonly connectionId: string;
  readonly mqttDeviceId: string;
  readonly deviceSk: string;
  /** Never the card service's: it does not use MQTT. */
  readonly background?: never;
}

type DeviceConnection = WebSocketConnection | MqttConnection;

const DEVICE_SK_PREFIX = 'DEV#';
/** The same three topics the television's MqttChannel uses, and the authorizer's policy allows it. */
const mqttTopic = (deviceId: string, kind: 'cards' | 'control'): string => `wick/device/${deviceId}/${kind}`;

/** The DEV# attributes each connection lives in — the same names connection-slot.mjs writes. */
const FOREGROUND_ATTRIBUTES = ['connectionId', 'transport', 'wsEndpoint', 'connectedAt'] as const;
const BACKGROUND_ATTRIBUTES = ['bgConnectionId', 'bgTransport', 'bgWsEndpoint', 'bgConnectedAt'] as const;

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
 *
 * One connection per television: the Wick app when it is on screen, and
 * otherwise the app's card service, which keeps running behind another app
 * and can only put up a toast saying a card is waiting (edge-device's
 * connection-slot.mjs). Never both — the app closes its connection when it
 * leaves the screen, so a foreground connection means the card itself will
 * be seen and a toast over it would say the same thing twice.
 *
 * And none at all for a television that has been revoked — nor for
 * `exceptDeviceId`, the one a card is not being taken off because it is the
 * one that was pressed (withdrawFromDevices).
 */
export function liveDeviceConnections(items: readonly Record<string, AttributeValue>[], exceptDeviceId?: string): DeviceConnection[] {
  const live: DeviceConnection[] = [];
  for (const item of items) {
    const connectionId = item.connectionId?.S;
    const wsEndpoint = item.wsEndpoint?.S;
    const deviceSk = item.sk?.S;
    if (!deviceSk) continue;
    if (exceptDeviceId !== undefined && deviceSk === `${DEVICE_SK_PREFIX}${exceptDeviceId}`) continue;
    // Revoked. connect.mjs refuses a revoked television a new connection,
    // but one it already holds stays open — the card service's for hours —
    // so it is refused here as well, on both.
    if (item.denylisted?.BOOL === true) continue;
    if (connectionId) {
      // The app is on screen, on one of its two channels. If the row names
      // neither, the app still holds the television and the card service is
      // not a second way to it.
      if (item.transport?.S === 'websocket' && wsEndpoint) live.push({ connectionId, wsEndpoint, deviceSk });
      else if (item.transport?.S === 'mqtt' && deviceSk.startsWith(DEVICE_SK_PREFIX)) {
        live.push({ connectionId, mqttDeviceId: deviceSk.slice(DEVICE_SK_PREFIX.length), deviceSk });
      }
      continue;
    }
    const bgConnectionId = item.bgConnectionId?.S;
    const bgWsEndpoint = item.bgWsEndpoint?.S;
    if (bgConnectionId && item.bgTransport?.S === 'websocket' && bgWsEndpoint) {
      live.push({ connectionId: bgConnectionId, wsEndpoint: bgWsEndpoint, deviceSk, background: true });
    }
  }
  return live;
}

async function findDeviceConnections(householdId: string, exceptDeviceId?: string): Promise<DeviceConnection[]> {
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
  return liveDeviceConnections(items, exceptDeviceId);
}

/**
 * One push per live device. Every device is attempted even if another
 * fails, then the first real failure is rethrown — one broken television
 * must not keep a card off the others.
 */
async function pushToDevices(householdId: string, payload: DeviceWireMessage, exceptDeviceId?: string): Promise<void> {
  const conns = await findDeviceConnections(householdId, exceptDeviceId);
  const results = await Promise.allSettled(
    conns.map((conn) => ('mqttDeviceId' in conn ? pushOverMqtt(conn, payload) : pushOverWebSocket(householdId, conn, payload))),
  );
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}

/** Where, and what, to publish for one message. Pure, so it is tested without AWS. */
export function mqttPublication(deviceId: string, payload: DeviceWireMessage): { readonly topic: string; readonly body: string } {
  // The WebSocket carries one stream and so wraps each message in its kind;
  // MQTT has a topic per kind, and the television reads each topic's body bare.
  return payload.kind === 'card'
    ? { topic: mqttTopic(deviceId, 'cards'), body: JSON.stringify(payload.card) }
    : { topic: mqttTopic(deviceId, 'control'), body: JSON.stringify(payload.control) };
}

let iot: IoTDataPlaneClient | undefined;

/**
 * Publish one payload to a television on MQTT. QoS 1: the broker holds it
 * until the television has it. A television that has just dropped is not an
 * error here — IoT Core accepts the publish, and what was missed is replayed
 * when it reconnects and asks (device-event.mjs reconcile), as on the WebSocket.
 */
async function pushOverMqtt(conn: MqttConnection, payload: DeviceWireMessage): Promise<void> {
  iot ??= new IoTDataPlaneClient({});
  const { topic, body } = mqttPublication(conn.mqttDeviceId, payload);
  await iot.send(new PublishCommand({ topic, qos: 1, payload: new TextEncoder().encode(body) }));
}

/**
 * Push one payload over an open connection, cleaning up a stale one rather
 * than surfacing GoneException to the caller — the payload was already
 * durable in DynamoDB (the CARD# item, or the patched CARD# item) before this
 * runs, so a dead connection here is a missed live push, not a lost update.
 */
async function pushOverWebSocket(
  householdId: string,
  conn: WebSocketConnection,
  payload: DeviceWireMessage,
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
      const attributes = conn.background ? BACKGROUND_ATTRIBUTES : FOREGROUND_ATTRIBUTES;
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: `HH#${householdId}` }, sk: { S: conn.deviceSk } },
          UpdateExpression: `REMOVE ${attributes.join(', ')}`,
          ConditionExpression: `${attributes[0]} = :cid`,
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

/**
 * Takes a card off every television in the home that is showing it — the
 * `revoke` both televisions already understand. For a card answered on one
 * screen while another still has it up (a note, or "Shall I tell Sarah?",
 * in two rooms). `exceptDeviceId` is the television that was pressed, when
 * it is known: it has put the card away itself.
 *
 * Only the live push. The stored card is retired by the press itself (the
 * edge's card-acted.mjs), so a television that connects later is not handed
 * it again — and is told to drop its own copy, if it holds one (the edge's
 * reconcile).
 */
export async function withdrawFromDevices(cardId: string, householdId: string, exceptDeviceId?: string): Promise<void> {
  await pushToDevices(householdId, { kind: 'control', control: { t: 'revoke', cardId } }, exceptDeviceId);
}

// ---------------------------------------------------------------------------
// The family's own browsers (Web Push).
// ---------------------------------------------------------------------------

/** The keys Wick signs a nudge with (VAPID, RFC 8292): `wick/push/vapid`, seeded once by infra/bootstrap/generate-push-keys.sh. */
interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  /** Who a push service may write to about this sender: a mailto: or https: address. */
  readonly subject: string;
}

let secrets: SecretsManagerClient | undefined;
let vapid: Promise<VapidKeys> | undefined;

async function loadVapidKeys(secretId: string): Promise<VapidKeys> {
  secrets ??= new SecretsManagerClient({});
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const keys = JSON.parse(res.SecretString ?? '{}') as Partial<VapidKeys>;
  if (!keys.publicKey || !keys.privateKey || !keys.subject) throw new Error('push keys are not set');
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject: keys.subject };
}

/** How long a push service may hold a nudge for a browser that is asleep: the life of a door card, no longer. */
const NUDGE_TTL_SEC = 5 * 60;

/**
 * The only path to a family member's browser when the family app is not
 * open. It sends a kind and nothing else (packages/contracts push.ts): no
 * string about the house leaves here, so there is nothing for the Guardian
 * to pass or refuse — and the kind is a fixed set, never text.
 *
 * Does nothing, quietly, in a deployment that has no push keys. Whoever
 * calls it has already done what mattered (push/nudge.ts).
 */
export async function nudgeFamily(userIds: readonly string[], kind: PushKind): Promise<NudgeOutcome> {
  const secretId = process.env.PUSH_VAPID_SECRET_ARN;
  if (!secretId || userIds.length === 0) return { sent: 0, gone: 0, failed: 0 };

  // Kept for the life of the container; a failed read is tried again next time.
  vapid ??= loadVapidKeys(secretId);
  let keys: VapidKeys;
  try {
    keys = await vapid;
  } catch (err) {
    vapid = undefined;
    throw err;
  }

  const outcome = await nudge(userIds, kind, {
    listSubscriptions: async (userId) => {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: `USER#${userId}` }, ':prefix': { S: PUSH_SK_PREFIX } },
      }));
      return (res.Items ?? []).map(subscriptionFromItem).filter((s): s is StoredSubscription => s !== undefined);
    },
    post: async (subscription, payload) => {
      try {
        const res = await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
          { vapidDetails: keys, TTL: NUDGE_TTL_SEC, urgency: 'high', timeout: 5000 },
        );
        return res.statusCode;
      } catch (err) {
        // The library rejects on any answer but 2xx, carrying the status.
        const status = (err as { statusCode?: unknown }).statusCode;
        if (typeof status === 'number') return status;
        throw err;
      }
    },
    forget: async (userId, sk) => {
      await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: `USER#${userId}` }, sk: { S: sk } } }));
    },
  });

  // Counts only — never an address, never who.
  console.log(JSON.stringify({ level: 'info', msg: 'family_nudged', kind, ...outcome }));
  return outcome;
}
