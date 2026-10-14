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
import {
  DEFAULT_LANGUAGE,
  DOOR_CARD_TTL_MS,
  MANTEL_URL_TTL_SEC,
  MAX_CARD_ACTIONS,
  PUSH_SK_PREFIX,
  cardIn,
  freeTextOf,
  homeIn,
  isPhotoId,
  patchIn,
  photoObjectKey,
  type Card,
  type CardPatch,
  type DeviceWireMessage,
  type FactClass,
  type FreeField,
  type FreeText,
  type HomeState,
  type HouseholdLanguage,
  type OtherLanguage,
  type PushKind,
  type QueuedCard,
} from '@wick/contracts';
import { DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { S3Client } from '@aws-sdk/client-s3';
import type { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import webpush from 'web-push';
import { languageReader } from './language/householdLanguage.js';
import { knownNames, translateFree, type TranslateCall } from './language/translate.js';
import { nudge, subscriptionFromItem, type NudgeOutcome, type StoredSubscription } from './push/nudge.js';
import { loadHouseholdLanguage } from './store/household.js';

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
 *
 * The payload may still be on its way — what the home screen is told waits
 * for the household's language — and is waited for while the televisions
 * are being found, not before.
 */
async function pushToDevices(householdId: string, message: DeviceWireMessage | Promise<DeviceWireMessage>, exceptDeviceId?: string): Promise<void> {
  const [conns, payload] = await Promise.all([findDeviceConnections(householdId, exceptDeviceId), message]);
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

/**
 * Where a card's free text is kept in her language, beside the card:
 * `tr_<language>` on the CARD# item, a JSON object by field. The edge reads
 * the same name when it sends a stored card again (edge-device
 * language.mjs), so it never has to ask a translator.
 */
export const translationAttribute = (language: OtherLanguage): string => `tr_${language}`;

/**
 * The CARD# queue item. Pure, so its shape is tested without AWS.
 *
 * `data` is always the card in English, as it was written: a note's reply
 * is copied from it to the family, patches are merged into it, and every
 * family tool reads it. A translation never goes in it — it sits beside it.
 */
export function cardItem(
  card: QueuedCard,
  serverOnly: ServerOnly = {},
  translated?: { readonly language: OtherLanguage; readonly free: FreeText },
): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {
    pk: { S: `HH#${card.card.householdId}` },
    sk: { S: `CARD#${card.id}` },
    data: { S: JSON.stringify(card) },
  };
  if (card.expiresAt !== undefined) {
    item.ttl = { N: String(Math.floor(card.expiresAt / 1000)) };
  }
  if (serverOnly.ringDeviceId) item.ringDeviceId = { S: serverOnly.ringDeviceId };
  if (translated && Object.keys(translated.free).length > 0) item[translationAttribute(translated.language)] = { S: JSON.stringify(translated.free) };
  return item;
}

// ---------------------------------------------------------------------------
// The television speaks her language (packages/contracts language.ts).
//
// Everything bound for her television passes the three functions below, so
// this is the one place it is put into her language — on its way out, and
// nowhere else. What is stored stays the English it was written in.
//
// An English household is sent, and has written for it, exactly what it
// always was: the only thing added is one small read of which language it
// is — made at every send, never remembered from an earlier one
// (language/householdLanguage.ts says why).
//
// A send that straddles her answer. The read and the push are two steps, so
// a card whose language was read an instant before she changed it arrives
// in the old one. Nothing stale is stored by that: `data` is the English
// card whichever language was read. Her television asks for its cards again
// when its language changes, and the edge replays each stored card in the
// language as it is then (edge-device language.mjs) — Wick's own sentences
// from the phrasebook, and free text from the translation kept beside the
// card. If the card was sent while the household still read as English, no
// translation was made, and none is made later: THE EDGE NEVER CALLS A
// TRANSLATOR. Such a note is replayed with Wick's words in her language and
// its own text as it was written — exactly as a note sent before she chose
// the language at all. That is accepted: it is one card, in the instant of
// the change, and its words are whole and true in the language they were
// written in.
// ---------------------------------------------------------------------------

/** The phrasebook's four functions (packages/contracts phrasebook). */
interface Phrasebook {
  readonly freeTextOf: (card: Card) => FreeText;
  readonly cardIn: (language: OtherLanguage, card: Card, free?: FreeText) => Card;
  readonly patchIn: (language: OtherLanguage, patch: CardPatch, free?: FreeText) => CardPatch;
  readonly homeIn: (language: OtherLanguage, home: HomeState) => HomeState;
}

/** What sending to her television needs. Handed in, so every path is tested without AWS. */
export interface DeviceEgressDeps {
  readonly table: string;
  readonly db: Pick<DynamoDBClient, 'send'>;
  /** pushToDevices: one push per live television. */
  readonly push: (householdId: string, message: DeviceWireMessage | Promise<DeviceWireMessage>, exceptDeviceId?: string) => Promise<void>;
  /** The household's language, read now — never one remembered from an earlier send. Never throws. */
  readonly languageOf: (householdId: string) => Promise<HouseholdLanguage>;
  /** One call to Amazon Translate (language/translate.ts). */
  readonly translate: TranslateCall;
  readonly phrasebook: Phrasebook;
  /**
   * A short-lived address for one of a household's pictures (packages/contracts
   * mantel.ts) — or nothing, when one cannot be made. Without it a picture's
   * card goes with its words and no picture.
   */
  readonly pictureAddress?: (householdId: string, photoId: string) => Promise<string | undefined>;
  readonly now?: () => number;
  readonly log?: (line: Record<string, unknown>) => void;
}

/** How many of the cards she has not answered are put into a language she has just chosen: the newest. */
export const CATCH_UP_MAX_CARDS = 20;
/** How long all of that may take, translations and all. */
export const CATCH_UP_BUDGET_MS = 6000;

/**
 * What a catching-up came to: the cards still waiting for her; how many had
 * a translation kept beside them; and how many were sent again and stand —
 * one that was answered, withdrawn or over by then is not among those.
 */
export interface CatchUpOutcome {
  readonly waiting: number;
  readonly translated: number;
  readonly sent: number;
}

const FREE_FIELDS: readonly FreeField[] = ['transcript', 'description', 'text'];

/** A card's free text, less anything empty. */
function freeWords(free: FreeText): FreeText {
  return Object.fromEntries(FREE_FIELDS.flatMap((field) => {
    const text = free[field];
    return typeof text === 'string' && text.trim().length > 0 ? [[field, text] as const] : [];
  }));
}

/** The translations kept beside a stored card, by field; nothing when there are none, or they cannot be read. */
function storedTranslations(value: AttributeValue | undefined): FreeText {
  if (!value?.S) return {};
  try {
    const kept = JSON.parse(value.S) as unknown;
    return typeof kept === 'object' && kept !== null ? freeWords(kept as FreeText) : {};
  } catch {
    return {};
  }
}

/**
 * A picture's card as it is kept: its id and Wick's words, and nothing else
 * of the picture. An address is for a television, for an hour — it is never
 * in a row, whoever handed the card in with one. Every other card is
 * returned as it is, the same object.
 */
function asStored(card: QueuedCard): QueuedCard {
  if (card.card.type !== 'PHOTO' || !('photoUrl' in card.card)) return card;
  const { photoUrl: _never, ...words } = card.card;
  return { ...card, card: words };
}

/**
 * A stored card as it is sent again — the edge's own rule, to the letter
 * (edge-device card-acted.mjs replayedCard): as it was stored, with the
 * showings counted since. A door card keeps the count it was sent with.
 */
function asReplayed(row: Record<string, AttributeValue>, stored: QueuedCard): QueuedCard {
  if (stored.urgency === 'DOOR' || !row.shown?.N) return stored;
  return { ...stored, shownCount: Math.max(Number(stored.shownCount ?? 0), Number(row.shown.N)) };
}

/**
 * Whether a stored card is still waiting for her: not answered, and — for a
 * door card — its visitor not gone. The edge's rule for what a television
 * is handed again (card-acted.mjs isReplayable), so the two agree on which
 * cards there are to send.
 */
function stillWaiting(row: Record<string, AttributeValue>, stored: QueuedCard, now: number): boolean {
  if (row.actedAt) return false;
  if (stored.urgency !== 'DOOR') return true;
  return now < (stored.expiresAt ?? (stored.queuedAt ?? 0) + DOOR_CARD_TTL_MS);
}

export function deviceEgress(deps: DeviceEgressDeps) {
  const { table, db, push, languageOf, translate, phrasebook, pictureAddress, log, now = Date.now } = deps;
  const say = log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const inHerLanguage = (free: FreeText, language: OtherLanguage, names: readonly string[], timeoutMs?: number): Promise<FreeText> =>
    translateFree({ free, language, names, call: translate, ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(log ? { log } : {}) });

  /**
   * The last step before a card is pushed, in every language: a picture's
   * card is given an address minted now (packages/contracts mantel.ts). It
   * is added to what is pushed and to nothing else — not the row, not a bus
   * event, not a log. A card no address can be minted for still goes, with
   * its words. Every other card passes as it is, the same object.
   */
  const withPicture = async (queued: QueuedCard): Promise<QueuedCard> => {
    if (queued.card.type !== 'PHOTO') return queued;
    let photoUrl: string | undefined;
    try {
      photoUrl = await pictureAddress?.(queued.card.householdId, queued.card.photoId);
    } catch (err) {
      // Why, and never which picture or whose.
      (log ?? ((line) => console.error(JSON.stringify(line))))({ level: 'error', msg: 'picture_address_failed', reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
    }
    return photoUrl ? { ...queued, card: { ...queued.card, photoUrl } } : queued;
  };

  return {
    async sendToDevice(handed: QueuedCard, _policy: HouseholdPolicy, serverOnly: ServerOnly = {}): Promise<void> {
      // What is stored, translated and built on is the card without any address (asStored).
      const card = asStored(handed);
      const householdId = card.card.householdId;
      const english = freeWords(phrasebook.freeTextOf(card.card));

      /**
       * The Card item is the queue's source of truth — written before any
       * attempt at a live push, so connect.mjs's reconcile step can always
       * deliver it later even if the device is offline right now.
       *
       * A door card is written once. Its id comes from Ring's event id
       * (agents/door/index.ts), so a ring handled twice — a Lambda retry
       * after a timeout, a webhook Ring sent again — builds the same card,
       * and by then the first one may have its picture and sentence patched
       * in, or have been answered. Writing it again would put the bare
       * Phase 1 card back over all of that. So the second write is refused,
       * and what is stored is sent instead, if she has not answered it yet:
       * the first attempt's push may be the part that failed.
       *
       * Every other card is written as it always was: some are sent again
       * under the same id on purpose, to change what they say (Hold for
       * Sarah's card, agents/reach).
       */
      const putCard = async (item: Record<string, AttributeValue>): Promise<Record<string, AttributeValue> | undefined> => {
        if (card.urgency !== 'DOOR') {
          await db.send(new PutItemCommand({ TableName: table, Item: item }));
          return undefined;
        }
        try {
          await db.send(new PutItemCommand({
            TableName: table,
            Item: item,
            ConditionExpression: 'attribute_not_exists(sk)',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }));
          return undefined;
        } catch (err) {
          if ((err as { name?: unknown } | undefined)?.name !== 'ConditionalCheckFailedException') throw err;
          return (err as { Item?: Record<string, AttributeValue> }).Item ?? {};
        }
      };

      /** The door card already stored, sent again as it now stands — or not at all, once answered or gone. */
      const sendStored = async (row: Record<string, AttributeValue>, language: HouseholdLanguage): Promise<void> => {
        say({ level: 'info', msg: 'door_card_already_stored', cardId: card.id });
        let stored: QueuedCard | undefined;
        try {
          stored = row.data?.S ? (JSON.parse(row.data.S) as QueuedCard) : undefined;
        } catch {
          stored = undefined;
        }
        if (!stored || !stillWaiting(row, stored, now())) return;
        const told = language === DEFAULT_LANGUAGE
          ? stored
          : { ...stored, card: phrasebook.cardIn(language, stored.card, storedTranslations(row[translationAttribute(language)])) };
        await push(householdId, { kind: 'card', card: told });
      };

      if (Object.keys(english).length === 0) {
        // Every word of this card is Wick's own — the door's first card is one —
        // so its row is the same whatever her language: it is written while
        // the language is being read, not after.
        const [language, existing] = await Promise.all([languageOf(householdId), putCard(cardItem(card, serverOnly))]);
        if (existing) return sendStored(existing, language);
        // No live device: reconcile delivers it the moment one is next seen.
        await push(householdId, { kind: 'card', card: await withPicture(language === DEFAULT_LANGUAGE ? card : { ...card, card: phrasebook.cardIn(language, card.card) }) });
        return;
      }

      const language = await languageOf(householdId);
      if (language === DEFAULT_LANGUAGE) {
        const existing = await putCard(cardItem(card, serverOnly));
        if (existing) return sendStored(existing, language);
        await push(householdId, { kind: 'card', card: await withPicture(card) });
        return;
      }

      // A note, the week's paragraph: translated once, here, and kept beside
      // the English card in the same write, so the edge can send it again in
      // her language without asking anyone (edge-device language.mjs).
      const free = await inHerLanguage(english, language, knownNames(card.card));
      const existing = await putCard(cardItem(card, serverOnly, { language, free }));
      if (existing) return sendStored(existing, language);
      await push(householdId, { kind: 'card', card: await withPicture({ ...card, card: phrasebook.cardIn(language, card.card, free) }) });
    },

    async sendPatchToDevice(patch: CardPatch, householdId: string): Promise<void> {
      const Key = { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${patch.cardId}` } };
      const [existing, language] = await Promise.all([db.send(new GetItemCommand({ TableName: table, Key })), languageOf(householdId)]);
      if (!existing.Item?.data?.S) return;

      const stored = JSON.parse(existing.Item.data.S) as QueuedCard;
      const patched: QueuedCard = { ...stored, card: applyCardPatch(stored.card, patch) };
      const data = { S: JSON.stringify(patched) };

      // A patch's one free field is the door's description.
      const describes = language !== DEFAULT_LANGUAGE && patch.description !== undefined;
      if (!describes) {
        await db.send(new UpdateItemCommand({
          TableName: table,
          Key,
          UpdateExpression: 'SET #data = :data',
          ExpressionAttributeNames: { '#data': 'data' },
          ExpressionAttributeValues: { ':data': data },
        }));
        // No live device: reconcile replays the patched CARD# item on next connect.
        await push(householdId, { kind: 'control', control: { t: 'patch', patch: language === DEFAULT_LANGUAGE ? patch : phrasebook.patchIn(language, patch) } });
        return;
      }

      const attribute = translationAttribute(language);
      const free = await inHerLanguage(freeWords({ description: patch.description }), language, knownNames(stored.card, patch));
      // What was translated before stands for the fields this patch leaves
      // alone. The description is the new one or none: an older translation
      // must not go on speaking for a description that has changed.
      const { description: _replaced, ...others } = storedTranslations(existing.Item[attribute]);
      const kept: FreeText = { ...others, ...free };
      const some = Object.keys(kept).length > 0;
      await db.send(new UpdateItemCommand({
        TableName: table,
        Key,
        UpdateExpression: some ? 'SET #data = :data, #tr = :tr' : 'SET #data = :data REMOVE #tr',
        ExpressionAttributeNames: { '#data': 'data', '#tr': attribute },
        ExpressionAttributeValues: { ':data': data, ...(some ? { ':tr': { S: JSON.stringify(kept) } } : {}) },
      }));
      await push(householdId, { kind: 'control', control: { t: 'patch', patch: phrasebook.patchIn(language, patch, free) } });
    },

    async sendHomeToDevices(
      householdId: string,
      home: HomeState,
      options: { readonly whole?: boolean; readonly exceptDeviceId?: string | undefined } = {},
    ): Promise<void> {
      const message = async (): Promise<DeviceWireMessage> => {
        // What the home is told carries the language with it — told whole,
        // it is how the home's other televisions hear that she has just
        // changed it. Like every send, it is read now.
        const language = await languageOf(householdId);
        let told = home;
        if (language !== DEFAULT_LANGUAGE) {
          told = phrasebook.homeIn(language, { ...home, language });
        } else if (home.language !== undefined) {
          // Said by somebody who had not heard she went back to English.
          const { language: _left, ...rest } = home;
          told = rest;
        }
        return { kind: 'control', control: { t: 'home', home: told, ...(options.whole ? { whole: true } : {}) } };
      };
      // The language is read while the televisions are found (pushToDevices).
      await push(householdId, message(), options.exceptDeviceId);
    },

    /**
     * She has just chosen a language that is not English: the cards she has
     * not yet answered are put into it, whole.
     *
     * Her television asks for its cards again the moment its language
     * changes, and the edge replays each in her language — Wick's own
     * sentences from the phrasebook, free text from the translation kept
     * beside the card. A card sent while the home was English has none, and
     * the edge never asks a translator: so a waiting note came back with
     * Spanish buttons under English words. This closes that. For each card
     * still waiting that has free text and no translation yet, the text is
     * translated here — by the same translator, under the same guards, as a
     * card on its way out — kept beside the card, and the card is sent to
     * the home's televisions again.
     *
     * Sent again, not sent anew. Nothing of the card is rewritten: `data`
     * stays the English it was, the same id, the same `queuedAt`, the
     * showings as the edge has counted them — it is, to the byte, what the
     * edge's replay now gives (asReplayed), so her television replaces the
     * card it holds and does not take it for another showing.
     *
     * The order of things: her television's own asking usually arrives
     * first, before a translation is kept — for a moment that replay shows
     * the note with its English text, and then this replaces it. An asking
     * that arrives after uses the translation kept here, and is the same
     * card.
     *
     * Bounded: the newest twenty of the cards still waiting, and one budget
     * of time for all of it. A translation that is not to be had leaves that
     * card exactly as it was. The translation is kept only if the card is
     * still unanswered and still the card that was read — one she answers
     * meanwhile, or whose words change, is left alone and not sent.
     *
     * NOTHING FINISHED IS PUT BACK ON HER SCREEN. Translating takes time,
     * and in that time a card can be answered on another television of the
     * home, or taken back by its sender — its `revoke` reaches her
     * televisions, and a push made from what was read earlier would put the
     * finished card back in front of her. So the reading at the start
     * decides nothing about the push (sendAgain, below):
     *
     *   - a card whose translation could not be kept is never pushed;
     *   - immediately before the push the row is read again, as it is that
     *     instant — still there, still unanswered, not over, the same card
     *     that was read, and the household still speaking this language — or
     *     it is not pushed;
     *   - and once more after the push: if it has been answered or is gone,
     *     it is taken back off her televisions with the same `revoke` a
     *     withdrawn card gets; if its words or the household's language
     *     changed underneath, it is sent once more as it now stands, so the
     *     copy just pushed does not hide the change.
     *
     * What is left is the instant between that last look and a `revoke`
     * reaching the television: a card answered in exactly that instant is
     * taken off by its own answer's `revoke` (which then comes after the
     * push), or — if that had already passed — stays until her television
     * next asks for its cards, when the edge takes back every finished card
     * it holds (edge-device card-acted.mjs finishedAmong). A press on it in
     * between changes nothing: every answer is written on a condition that
     * the question is still open.
     *
     * The household's row, read now, is what counts — not what the event
     * said: delivered late, after she has changed back, it does nothing.
     * Delivered twice, the second finds every translation there and makes
     * none. English needs nothing: the stored card is English.
     *
     * Never throws. Says what it did in numbers, under the id of the change
     * (INV-6) — never a card's words, or which cards.
     */
    async catchUpInLanguage(householdId: string, language: HouseholdLanguage, options: { readonly correlationId?: string | undefined; readonly budgetMs?: number } = {}): Promise<CatchUpOutcome> {
      const nothing: CatchUpOutcome = { waiting: 0, translated: 0, sent: 0 };
      if (language === DEFAULT_LANGUAGE) return nothing;
      const budgetMs = options.budgetMs ?? CATCH_UP_BUDGET_MS;
      try {
        if ((await languageOf(householdId)) !== language) return nothing;

        const rows: Record<string, AttributeValue>[] = [];
        let startKey: Record<string, AttributeValue> | undefined;
        do {
          const page = await db.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
            ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'CARD#' } },
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }));
          rows.push(...(page.Items ?? []));
          startKey = page.LastEvaluatedKey;
        } while (startKey);

        const at = now();
        const attribute = translationAttribute(language);
        const waiting = rows
          .flatMap((row) => {
            if (!row.data?.S) return [];
            try {
              const stored = JSON.parse(row.data.S) as QueuedCard;
              return stored?.card && typeof stored.id === 'string' && stillWaiting(row, stored, at) ? [{ row, stored }] : [];
            } catch {
              return [];
            }
          })
          // The newest first, and no more than the bound.
          .sort((a, b) => (b.stored.queuedAt ?? 0) - (a.stored.queuedAt ?? 0));

        type Row = Record<string, AttributeValue>;
        /** One card's row as it is this instant. */
        const rowNow = async (Key: Row): Promise<Row | undefined> => (await db.send(new GetItemCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
        /** The card a row holds, if it is still waiting for her now: there, unanswered, and not over. */
        const waitingIn = (row: Row | undefined): QueuedCard | undefined => {
          if (!row?.data?.S) return undefined;
          try {
            const card = JSON.parse(row.data.S) as QueuedCard;
            return card?.card && stillWaiting(row, card, now()) ? card : undefined;
          } catch {
            return undefined;
          }
        };
        /** A stored card as her television should show it now — exactly what the edge's replay of that row gives. */
        const asItStands = (row: Row, card: QueuedCard, speaking: HouseholdLanguage): QueuedCard => {
          const again = asReplayed(row, card);
          return speaking === DEFAULT_LANGUAGE ? again : { ...again, card: phrasebook.cardIn(speaking, again.card, storedTranslations(row[translationAttribute(speaking)])) };
        };
        const takeBack = (cardId: string): Promise<void> => push(householdId, { kind: 'control', control: { t: 'revoke', cardId } });

        /**
         * One card sent again — only if, at this instant, it is still the
         * card that was read and still hers to answer; and looked at once
         * more afterwards. Says whether a copy now stands on her televisions.
         */
        const sendAgain = async (Key: Row, cardId: string, dataRead: string): Promise<boolean> => {
          const [before, speaking] = await Promise.all([rowNow(Key), languageOf(householdId)]);
          const card = waitingIn(before);
          if (!before || !card || before.data!.S !== dataRead || speaking !== language) return false;
          await push(householdId, { kind: 'card', card: await withPicture(asItStands(before, card, language)) });

          const [after, then] = await Promise.all([rowNow(Key), languageOf(householdId)]);
          const still = waitingIn(after);
          if (!after || !still) {
            // Answered, withdrawn or over while it was on its way: it comes off again.
            await takeBack(cardId);
            return false;
          }
          if (after.data!.S === before.data!.S && then === language) return true;

          // Its words, or the household's language, changed underneath: once more, as it now stands.
          await push(householdId, { kind: 'card', card: await withPicture(asItStands(after, still, then)) });
          if (!waitingIn(await rowNow(Key))) {
            await takeBack(cardId);
            return false;
          }
          return true;
        };

        const results = await Promise.all(waiting.slice(0, CATCH_UP_MAX_CARDS).map(async ({ row, stored }): Promise<{ readonly translated: boolean; readonly sent: boolean }> => {
          const untouched = { translated: false, sent: false };
          try {
            // The question that asks for a language is in both already, and is never put through anything.
            if (stored.card.type === 'LANGUAGE') return untouched;
            const english = freeWords(phrasebook.freeTextOf(stored.card));
            const kept = storedTranslations(row[attribute]);
            const missing = freeWords(Object.fromEntries(Object.entries(english).filter(([field]) => kept[field as FreeField] === undefined)));
            if (Object.keys(missing).length === 0) return untouched;

            const free = await inHerLanguage(missing, language, knownNames(stored.card), budgetMs);
            if (Object.keys(free).length === 0) return untouched;
            const all = freeWords({ ...kept, ...free });
            const Key = { pk: row.pk!, sk: row.sk! };

            try {
              await db.send(new UpdateItemCommand({
                TableName: table,
                Key,
                UpdateExpression: 'SET #tr = :tr',
                // Still there, still unanswered, and still the card these words are a translation of.
                ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(actedAt) AND #data = :data',
                ExpressionAttributeNames: { '#tr': attribute, '#data': 'data' },
                ExpressionAttributeValues: { ':tr': { S: JSON.stringify(all) }, ':data': { S: row.data!.S! } },
              }));
            } catch (err) {
              // Answered, gone or changed since it was read: nothing is kept, and it is never pushed.
              if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return untouched;
              throw err;
            }

            try {
              return { translated: true, sent: await sendAgain(Key, stored.id, row.data!.S!) };
            } catch (err) {
              say({ level: 'error', msg: 'card_not_put_in_her_language', correlationId: options.correlationId, reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
              return { translated: true, sent: false };
            }
          } catch (err) {
            // One card that could not be done does not cost the others. Why, and never which.
            say({ level: 'error', msg: 'card_not_put_in_her_language', correlationId: options.correlationId, reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
            return untouched;
          }
        }));

        const outcome: CatchUpOutcome = { waiting: waiting.length, translated: results.filter((r) => r.translated).length, sent: results.filter((r) => r.sent).length };
        say({ level: 'info', msg: 'cards_put_in_her_language', correlationId: options.correlationId, language, ...outcome });
        return outcome;
      } catch (err) {
        say({ level: 'error', msg: 'cards_not_put_in_her_language', correlationId: options.correlationId, reason: (err as { name?: unknown } | undefined)?.name?.toString() ?? 'error' });
        return nothing;
      }
    },
  };
}

let translator: Promise<{ readonly client: TranslateClient; readonly Command: typeof TranslateTextCommand }> | undefined;

/**
 * Amazon Translate. Like every transport, it is reached from this module
 * and no other (eslint.config.js): nothing in the repository can put a
 * string through a translator except on its way to her television.
 *
 * Loaded the first time a household that is not English has free text to
 * send, and not before: an English household never pays for it, not even
 * at a cold start, and a runtime that could not load it would cost a
 * translation (the television shows the English) and never a card.
 */
const callTranslate: TranslateCall = async (input, signal) => {
  translator ??= import('@aws-sdk/client-translate').then((sdk) => ({ client: new sdk.TranslateClient({}), Command: sdk.TranslateTextCommand }));
  let loaded: Awaited<NonNullable<typeof translator>>;
  try {
    loaded = await translator;
  } catch (err) {
    // Tried again next time.
    translator = undefined;
    throw err;
  }
  return loaded.client.send(new loaded.Command({ ...input, ...(input.Settings ? { Settings: { ...input.Settings } } : {}) }), { abortSignal: signal });
};

/**
 * What is signed for a picture: a GET of its own object in the pictures'
 * bucket (infra/photos.tf), good for an hour. Nothing, without a bucket or
 * for an id that is not a picture's — the key is built from the card's own
 * household and an id Wick made, and nothing in a card can name another
 * object. Pure.
 */
export function pictureRequest(input: { readonly bucket: string | undefined; readonly householdId: string; readonly photoId: string }):
  | { readonly Bucket: string; readonly Key: string; readonly expiresIn: number }
  | undefined {
  if (!input.bucket || !input.householdId || !isPhotoId(input.photoId)) return undefined;
  return { Bucket: input.bucket, Key: photoObjectKey(input.householdId, input.photoId), expiresIn: MANTEL_URL_TTL_SEC };
}

let pictures: S3Client | undefined;

/**
 * A presigned address for one picture. The signer, like every transport, is
 * reached from this module and no other (eslint.config.js): an address to a
 * family's picture can only be made on its way to the resident's television.
 * It is returned to the push and goes nowhere else.
 *
 * Loaded at the first picture, not before — nothing else pays for it. The
 * address is good for no longer than the credentials that sign it: see
 * infra/photos.tf for what that means for an hour's address.
 */
async function signPictureAddress(householdId: string, photoId: string): Promise<string | undefined> {
  const request = pictureRequest({ bucket: process.env.PHOTOS_BUCKET, householdId, photoId });
  if (!request) return undefined;
  const [{ S3Client: Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);
  pictures ??= new Client({});
  return getSignedUrl(pictures, new GetObjectCommand({ Bucket: request.Bucket, Key: request.Key }), { expiresIn: request.expiresIn });
}

const languages = languageReader({ read: (householdId, options) => loadHouseholdLanguage(ddb, TABLE, householdId, options) });

const toDevices = deviceEgress({
  table: TABLE,
  db: ddb,
  push: pushToDevices,
  languageOf: languages.of,
  translate: callTranslate,
  phrasebook: { freeTextOf, cardIn, patchIn, homeIn },
  pictureAddress: signPictureAddress,
});

/**
 * The only path to the television.
 *
 * The resident is always audience RESIDENT, so the Guardian is permissive here —
 * but it still runs, because "the resident sees everything about themselves" is a
 * policy decision, not an absence of policy.
 */
export async function sendToDevice(
  card: QueuedCard,
  policy: HouseholdPolicy,
  serverOnly: ServerOnly = {},
): Promise<void> {
  await toDevices.sendToDevice(card, policy, serverOnly);
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
  await toDevices.sendPatchToDevice(patch, householdId);
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

/**
 * UpdateItem input finishing a stored card nobody pressed: its sender took
 * it back. The same stamp a press leaves (edge-device card-acted.mjs
 * markCardActed), so the edge keeps one rule for both — a television that
 * connects later is not handed the card, and one still holding it is told
 * to drop it (reconcile's finishedAmong). Pure.
 */
export function cardTakenBack(input: { readonly table: string; readonly householdId: string; readonly cardId: string; readonly at: number }) {
  return {
    TableName: input.table,
    Key: { pk: { S: `HH#${input.householdId}` }, sk: { S: `CARD#${input.cardId}` } },
    UpdateExpression: 'SET actedAt = if_not_exists(actedAt, :at)',
    // Never conjure a card that was not sent.
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':at': { N: String(input.at) } },
  };
}

/**
 * Takes a card back from the household's televisions altogether: one its
 * sender has withdrawn before the resident answered it (an invitation to
 * watch a film, mcp-server withdraw_watch_invitation.ts). The stored card is
 * finished first, so a television that is off never shows it; then every
 * television that has it up puts it away.
 */
export async function takeBackFromDevices(cardId: string, householdId: string, at: number = Date.now()): Promise<void> {
  try {
    await ddb.send(new UpdateItemCommand(cardTakenBack({ table: TABLE, householdId, cardId, at })));
  } catch (err) {
    // No such card stored: there is nothing to finish, and the push below is harmless.
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  }
  await withdrawFromDevices(cardId, householdId);
}

/**
 * She has just chosen a language: the cards she has not yet answered are
 * put into it and sent to her televisions again (deviceEgress
 * catchUpInLanguage says how, and why here). The only caller is the
 * function that hears the edge say her press changed the language
 * (agents/door/actionLambda.ts). Never throws.
 */
export async function sendWaitingCardsInLanguage(householdId: string, language: HouseholdLanguage, correlationId?: string): Promise<CatchUpOutcome> {
  return toDevices.catchUpInLanguage(householdId, language, { correlationId });
}

/**
 * Tells the household's televisions something for the home screen to say
 * beside its cards (packages/contracts light.ts): today, that somebody in
 * the family looked in. Resident-bound, and about the family's own act —
 * nothing about the house leaves it this way.
 *
 * Only the live push. A television that is off is told when it next asks
 * for what it is owed (the edge's reconcile works the same line out).
 */
export async function sendHomeToDevices(
  householdId: string,
  home: HomeState,
  options: {
    /** This is all of it: what is not given is no longer so (a light nobody can see any more). */
    readonly whole?: boolean;
    /** The television that already knows — the one she pressed — when there is one. */
    readonly exceptDeviceId?: string | undefined;
  } = {},
): Promise<void> {
  await toDevices.sendHomeToDevices(householdId, home, options);
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
