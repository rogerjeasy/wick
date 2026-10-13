/**
 * Sarah's television — what the Wick server says to a television a family
 * member connected as their own (packages/contracts familyTelevision.ts).
 *
 * It is the family app with a remote: `home` is what that one member may
 * already read through the family's tools, and `press` is an answer they
 * may already give. Nothing here is a second way to do either. The light is
 * get_light's `loadLight`, the door is get_door_request's `loadDoorRequest`
 * and answer_door_request's `answerDoorRequest`, a request to ring is
 * get_reach_request's `reachFor` and answer_reach_request's
 * `answerReachRequest` — the tools' own functions, so the television and
 * the tools cannot come to disagree about what a member is told.
 *
 * Who is asking is settled before anything of a household's is read, in
 * this order, and each step fails closed:
 *
 *   1. The token's signature, under RS256 and nothing else, with the pairing
 *      key's public half as published in the table (edge-device
 *      family-television.mjs). No key, no answer: there is no unverified path.
 *   2. The verified claims are a family television's (`kind: 'family'`, a
 *      member). The resident's own television is refused here: it is not a
 *      way to read as the family.
 *   3. The television's own row, `HH#<household>` / `FTV#<deviceId>`, read
 *      consistently: it exists, it is not revoked, and it was connected by
 *      the member the token names.
 *   4. INV-9, on every call: the resident allows that member now, and they
 *      are not a neighbour (who is asked two things and shown nothing —
 *      tools/context.ts).
 *
 * INV-8: the household and the member come from the verified token and that
 * row. `home` takes nothing else; `press` takes a card id and an answer's
 * key, and nothing in a request can name a household or a person.
 *
 * INV-2: an answer reaches the resident's television only through the
 * senders the server was given (server.ts AppDeps), which in a deployment
 * are egress.ts's. Nothing here holds a transport.
 *
 * No model is called, and nothing is logged that came out of a token.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DOOR_ANSWERS,
  FAMILY_TV_SK_PREFIX,
  PAIRING_PUBLIC_KEY_ROW,
  familyTvCardId,
  isDoorAnswer,
  isFamilyTelevisionToken,
  isReachAnswer,
  parseFamilyTvCardId,
  type CardAction,
  type CardPatch,
  type FamilyTvCard,
  type FamilyTvHome,
  type FamilyTvPressResult,
  type QueuedCard,
} from '@wick/contracts';
import { answerDoorRequest } from '../tools/answer_door_request.js';
import { answerReachRequest } from '../tools/answer_reach_request.js';
import { neighbourRefusal } from '../tools/context.js';
import { loadDoorRequest, loadLookRow } from '../tools/get_door_request.js';
import { loadLight } from '../tools/get_light.js';
import { firstName, reachFor, reachesOf } from '../tools/get_reach_request.js';
import { isSharedWithFamily, loadHouseholdPolicy } from '../tools/get_resident_shared_view.js';
import { recordLook, type SendHome } from '../tools/lookIn.js';
import type { AnswerOutcome } from '../tools/result.js';
import { checkAccess } from './circle.js';
import type { AccountStore } from './store.js';
import type { Household, Membership } from './types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

/** How long the published key is kept before it is read again. */
export const PAIRING_KEY_KEPT_MS = 5 * 60_000;
/**
 * How long "no key is published" is believed. Short, so the first family
 * television works within moments of being connected; not nothing, so
 * requests nobody can verify are not each a read of the table.
 */
export const NO_PAIRING_KEY_KEPT_MS = 10_000;
/** How long an answer stays on the family television after it was given. */
export const SETTLED_SHOWN_MS = 10 * 60_000;
/** Never more than three (AGENTS.md: three items, never four). */
const MAX_CARDS = 3;
/** A device token is a few hundred characters. Anything far longer is not one, and is not parsed. */
const MAX_AUTHORIZATION_CHARS = 4096;
/** The limits the tools put on the same ids (answer_door_request, answer_reach_request). */
const MAX_DOOR_REQUEST_ID_CHARS = 64;
const REACH_REQUEST_ID = /^\d{13,16}$/;

/** `Bearer <header>.<payload>.<signature>`, each part base64url and nothing else. */
const BEARER = /^Bearer +([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/i;

/** A button: the first is the one the remote starts on. */
const action = (id: string, label: string, index: number): CardAction => ({ id, label, kind: index === 0 ? 'primary' : 'secondary' });

/** The three things that can be said about who is at the door, each the sentence itself. */
const DOOR_ACTIONS: readonly CardAction[] = Object.entries(DOOR_ANSWERS).map(([key, text], index) => action(key, text, index));

export interface FamilyTelevisionDeps {
  /** The household's own rows, as the tools read them. */
  readonly ddb: DynamoDBClient;
  readonly store: AccountStore;
  /** egress.ts's sendToDevice — how an answer to a request to ring reaches the resident's television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts's sendPatchToDevice — how an answer reaches the door card (INV-2). */
  readonly sendPatch: (patch: CardPatch, householdId: string) => Promise<void>;
  /** egress.ts's sendHomeToDevices — how the resident's home screen is told who looked in. Absent, the look is still kept. */
  readonly sendHome?: SendHome | undefined;
  readonly now: () => number;
}

/** Why a television was refused. For the tests and the reader of this file: it is never sent, and never logged with anything from a token. */
export type TvRefusalReason =
  | 'no_token'
  | 'malformed_token'
  | 'bad_alg'
  | 'no_key'
  | 'bad_signature'
  | 'expired'
  | 'not_family'
  | 'no_row'
  | 'denylisted'
  | 'not_this_members'
  | 'not_allowed'
  | 'neighbour';

/** What a refused television is sent. `say` is a sentence it can show as it stands. */
export interface TvRefusal {
  readonly error: 'invalid_token' | 'token_expired' | 'television_not_connected' | 'not_a_family_television' | 'not_allowed' | 'bad_card' | 'bad_action';
  readonly say?: string;
}

export type TvReply<T> =
  | { readonly status: 200; readonly body: T }
  | { readonly status: 400 | 401 | 403; readonly body: TvRefusal; readonly reason?: TvRefusalReason };

type Refused = Extract<TvReply<never>, { body: TvRefusal }>;

/** A television that has been let in: whose it is, by the token, its row and the circle — and by nothing else. */
interface Caller {
  readonly householdId: string;
  readonly userId: string;
  readonly membership: Membership;
  readonly household: Household;
}

export interface FamilyTelevisionEndpoints {
  /** `GET /tv/home`. Takes the Authorization header and nothing else. */
  home(authorization: string | undefined): Promise<TvReply<FamilyTvHome>>;
  /** `POST /tv/press`. Takes the Authorization header and the request's JSON body. */
  press(authorization: string | undefined, body: unknown): Promise<TvReply<FamilyTvPressResult>>;
}

const refuse = (status: 401 | 403, error: TvRefusal['error'], reason: TvRefusalReason, say?: string): Refused => ({
  status,
  body: { error, ...(say === undefined ? {} : { say }) },
  reason,
});

/** One part of a token as a JSON object, or undefined for anything else. */
function jsonObject(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The published PEM as an RSA public key, or undefined for anything that is not one. */
function rsaPublicKey(pem: string | undefined): KeyObject | undefined {
  // Only the public half is ever published. Anything else in that row is a fault, not a key to trust.
  if (!pem || pem.includes('PRIVATE KEY')) return undefined;
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The pairing key's public half, from where pair-claim.mjs publishes it,
 * kept in memory for a few minutes. Undefined while there is none: the
 * caller then refuses everything.
 */
function pairingKey(ddb: DynamoDBClient, now: () => number): () => Promise<KeyObject | undefined> {
  let held: { readonly key: KeyObject | undefined; readonly until: number } | undefined;
  let reading: Promise<KeyObject | undefined> | undefined;

  const read = async (): Promise<KeyObject | undefined> => {
    const res = await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: PAIRING_PUBLIC_KEY_ROW.pk }, sk: { S: PAIRING_PUBLIC_KEY_ROW.sk } },
    }));
    const published = res.Item?.publicKeyPem?.S;
    const key = rsaPublicKey(published);
    if (!key) console.error(JSON.stringify({ level: 'error', msg: 'family_tv_no_pairing_key', published: published !== undefined }));
    held = { key, until: now() + (key ? PAIRING_KEY_KEPT_MS : NO_PAIRING_KEY_KEPT_MS) };
    return key;
  };

  return () => {
    if (held && now() < held.until) return Promise.resolve(held.key);
    // One read for everyone waiting on it. A read that fails is not remembered: the next request asks again.
    reading ??= read().finally(() => {
      reading = undefined;
    });
    return reading;
  };
}

export function createFamilyTelevision(deps: FamilyTelevisionDeps): FamilyTelevisionEndpoints {
  const { ddb, store, now } = deps;
  const publicKey = pairingKey(ddb, now);

  /**
   * The claims of a token this server can vouch for, or why not. Mirrors
   * edge-device jwt.mjs's verifyJwt, and is stricter where that is loose:
   * the header must say RS256 (so neither `none` nor an HMAC keyed with the
   * public key is ever considered), and a token must say when it expires.
   */
  async function verifiedClaims(authorization: string | undefined): Promise<{ readonly claims: Record<string, unknown> } | Refused> {
    if (!authorization) return refuse(401, 'invalid_token', 'no_token');
    const parts = authorization.length <= MAX_AUTHORIZATION_CHARS ? BEARER.exec(authorization) : null;
    if (!parts) return refuse(401, 'invalid_token', 'malformed_token');
    const [, headerPart, payloadPart, signaturePart] = parts as unknown as [string, string, string, string];

    const header = jsonObject(headerPart);
    if (!header) return refuse(401, 'invalid_token', 'malformed_token');
    if (header.alg !== 'RS256') return refuse(401, 'invalid_token', 'bad_alg');
    // An extension this server would have to understand, and does not (RFC 7515 §4.1.11).
    if ('crit' in header) return refuse(401, 'invalid_token', 'malformed_token');

    const key = await publicKey();
    if (!key) return refuse(401, 'invalid_token', 'no_key');

    let signed = false;
    try {
      signed = createVerify('RSA-SHA256').update(`${headerPart}.${payloadPart}`).verify(key, Buffer.from(signaturePart, 'base64url'));
    } catch {
      signed = false;
    }
    if (!signed) return refuse(401, 'invalid_token', 'bad_signature');

    const claims = jsonObject(payloadPart);
    const exp = claims?.exp;
    if (!claims || typeof exp !== 'number' || !Number.isFinite(exp)) return refuse(401, 'invalid_token', 'malformed_token');
    if (now() >= exp * 1000) return refuse(401, 'token_expired', 'expired');
    return { claims };
  }

  async function authenticate(authorization: string | undefined): Promise<Caller | Refused> {
    const verified = await verifiedClaims(authorization);
    if ('status' in verified) return verified;
    const { claims } = verified;
    // The resident's own television, or anything else the pairing key signed: not a way in here, and nothing is read for it.
    if (!isFamilyTelevisionToken(claims)) return refuse(403, 'not_a_family_television', 'not_family');
    const { householdId, deviceId, userId } = claims;

    // Consistent: a television removed or revoked a moment ago is refused now.
    const row = (await ddb.send(new GetItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `${FAMILY_TV_SK_PREFIX}${deviceId}` } },
      ConsistentRead: true,
    }))).Item;
    if (!row) return refuse(401, 'television_not_connected', 'no_row');
    // Absent is not revoked, as the edge reads it (family-television.mjs); anything there but a plain `false` is.
    if (row.denylisted !== undefined && row.denylisted.BOOL !== false) return refuse(401, 'television_not_connected', 'denylisted');
    if (row.userId?.S !== userId) return refuse(401, 'television_not_connected', 'not_this_members');

    // INV-9: asked again on every call, so the resident's press — and a removal — counts on the very next one.
    const access = await checkAccess(store, householdId, userId);
    if (!access.ok) return refuse(403, 'not_allowed', 'not_allowed', access.say);
    if (access.membership.role === 'neighbour') return refuse(403, 'not_allowed', 'neighbour', neighbourRefusal(access.household.residentName));
    return { householdId, userId, membership: access.membership, household: access.household };
  }

  /** Her light in one sentence — and the look that asking for it is. Undefined when she keeps the shape of her day to herself. */
  async function lightFor(who: Caller, at: number): Promise<FamilyTvHome['light']> {
    const policy = await loadHouseholdPolicy(ddb, who.householdId);
    if (!isSharedWithFamily('RHYTHM', policy)) return undefined;

    const [light] = await Promise.all([
      loadLight(ddb, who.householdId, at, who.household.residentName),
      // Asking after her is something she is told (tools/lookIn.ts) — once
      // every little while however often a television asks: recordLook's own
      // condition. Never the reason an answer fails, as in `gated`.
      recordLook(ddb, { householdId: who.householdId, userId: who.userId, name: who.membership.name }, at, deps.sendHome ?? (async () => {}))
        .catch((err: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'look_not_noted', err: err instanceof Error ? err.name : 'unknown' }))),
    ]);
    return { lit: light.lit, line: light.summary };
  }

  async function doorCard(who: Caller, at: number): Promise<FamilyTvCard | undefined> {
    const request = await loadDoorRequest(ddb, who.householdId, at);
    if (!request) return undefined;
    const id = familyTvCardId('door_look', request.requestId);

    if (request.state === 'waiting') {
      return {
        id,
        kind: 'door_look',
        headline: `${who.household.residentName} has asked you to look at the door.`,
        detail: request.description ?? request.line,
        ...(request.pictureUrl ? { pictureUrl: request.pictureUrl } : {}),
        actions: DOOR_ACTIONS,
      };
    }
    if (request.state === 'answered' && at - request.answer.at < SETTLED_SHOWN_MS) {
      // Who answered is on the row, not in what the tool hands out. The member
      // who answered was told so in the sentence their press came back with;
      // a card saying it again is one more thing to put away, and it would
      // come back each time the television is started. Everyone else is told who.
      const row = await loadLookRow(ddb, who.householdId, request.requestId);
      if (row?.answeredBy?.S === who.userId) return undefined;
      return { id, kind: 'door_look', headline: `${request.answer.by} answered: “${request.answer.text}”`, actions: [] };
    }
    // Gone from her television unanswered, or settled a while ago.
    return undefined;
  }

  async function reachCard(who: Caller, at: number): Promise<FamilyTvCard | undefined> {
    // Undefined for somebody not asked, exactly as for no request at all: nobody learns of her asking before their turn.
    const reach = reachFor(await reachesOf(ddb).latest(who.householdId), who.userId, who.household.residentName, at);
    if (!reach) return undefined;
    const id = familyTvCardId('reach', reach.requestId);

    if (reach.state === 'waiting') {
      return {
        id,
        kind: 'reach',
        headline: reach.summary,
        ...(reach.kind === 'ring' ? { detail: 'This does not make the call. Ring her yourself.' } : {}),
        actions: reach.answers.map(({ key, text }, index) => action(key, text, index)),
      };
    }
    // As at the door: nothing more for the member who answered, the name for everyone else.
    if (!reach.answer.yours && at - reach.answer.at < SETTLED_SHOWN_MS) {
      return { id, kind: 'reach', headline: `${reach.answer.by} answered: “${reach.answer.text}”`, actions: [] };
    }
    return undefined;
  }

  async function homeFor(who: Caller): Promise<FamilyTvHome> {
    const at = now();
    const [light, door, reach] = await Promise.all([lightFor(who, at), doorCard(who, at), reachCard(who, at)]);
    const cards = [door, reach].filter((card): card is FamilyTvCard => card !== undefined);
    // Most pressing first: what waits for an answer — the door before a request to ring — then what is settled.
    const waiting = cards.filter((card) => card.actions.length > 0);
    const settled = cards.filter((card) => card.actions.length === 0);
    return {
      residentName: who.household.residentName,
      memberName: firstName(who.membership.name),
      ...(light ? { light } : {}),
      cards: [...waiting, ...settled].slice(0, MAX_CARDS),
      ...(who.household.simulated ? { simulated: true as const } : {}),
    };
  }

  /** The member's press as one sentence: it is on her television, or why it is not (§6.4: a refusal is an answer). */
  const pressed = (outcome: AnswerOutcome): TvReply<FamilyTvPressResult> => ({
    status: 200,
    body: outcome.shown
      ? { done: true, say: `It is on the television now: “${outcome.by} says: ${outcome.text}”` }
      : { done: false, say: outcome.say },
  });

  async function pressFor(who: Caller, body: unknown): Promise<TvReply<FamilyTvPressResult>> {
    // A card and an answer's key: all a press may carry. Anything else in the body is never looked at (INV-8).
    const { cardId, action: chosen } = (typeof body === 'object' && body !== null ? body : {}) as { cardId?: unknown; action?: unknown };
    const card = parseFamilyTvCardId(cardId);
    if (!card) return { status: 400, body: { error: 'bad_card' } };
    const answerer = { householdId: who.householdId, userId: who.userId, memberName: who.membership.name, residentName: who.household.residentName };

    if (card.kind === 'door_look') {
      if (card.requestId.length > MAX_DOOR_REQUEST_ID_CHARS) return { status: 400, body: { error: 'bad_card' } };
      if (!isDoorAnswer(chosen)) return { status: 400, body: { error: 'bad_action' } };
      return pressed(await answerDoorRequest(ddb, answerer, card.requestId, chosen, deps.sendPatch, now()));
    }

    if (!REACH_REQUEST_ID.test(card.requestId)) return { status: 400, body: { error: 'bad_card' } };
    if (!isReachAnswer(chosen)) return { status: 400, body: { error: 'bad_action' } };
    return pressed(await answerReachRequest(ddb, answerer, card.requestId, chosen, deps.sendCard, now()));
  }

  return {
    async home(authorization) {
      const who = await authenticate(authorization);
      if ('status' in who) return who;
      return { status: 200, body: await homeFor(who) };
    },
    async press(authorization, body) {
      const who = await authenticate(authorization);
      if ('status' in who) return who;
      return pressFor(who, body);
    },
  };
}
