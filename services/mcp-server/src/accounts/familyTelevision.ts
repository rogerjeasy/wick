/**
 * Sarah's television — what the Wick server says to a television a family
 * member connected as their own (packages/contracts familyTelevision.ts).
 *
 * It is the family app with a remote. Four things are asked of it:
 *
 *   home     everything the screen shows: her light, what waits for this
 *            member, a wave that came back, a film arranged with her, her week;
 *   press    an answer this member may already give, or one of the few
 *            presses of the television's own (sit down, wave, read, seen);
 *   seat     the seat beside her film, for the member who invited her;
 *   waiting  what waits, for a television whose app is off the screen.
 *
 * Nothing here is a second way to read or to answer. Each piece is the
 * family tools' own function: the light is get_light's `loadLight`; the door
 * is get_door_request's `loadDoorRequest` and answer_door_request's
 * `answerDoorRequest`; a request to ring is get_reach_request's `reachFor`
 * and answer_reach_request's `answerReachRequest`; a film is
 * watchSession.ts's `mySessions` and `describeWatch`, join_watch_together's
 * `sitDownToWatch` and answer_watch_together's `answerWatchTogether`; her
 * week is get_week_narrative's `loadLatestFamilyWeek`. So the television and
 * the tools cannot come to disagree about what a member is told. The kinds
 * of card that are this television's own live beside this file: the week
 * (familyTvWeek.ts), a wave (familyTvWave.ts), the film seat (familyTvWatch.ts).
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
 *   3. What the token is for. The television's own token names no scope and
 *      is taken on every route. Its background service's names one
 *      (`scope: 'waiting'`) and is taken on `waiting` alone; any other
 *      scope is taken nowhere.
 *   4. The television's own row, `HH#<household>` / `FTV#<deviceId>`, read
 *      consistently: it exists, it is not revoked, and it was connected by
 *      the member the token names.
 *   5. INV-9, on every call: the resident allows that member now, and they
 *      are not a neighbour (who is asked two things and shown nothing —
 *      tools/context.ts).
 *
 * INV-8: the household and the member come from the verified token and that
 * row. The three reads take the Authorization header and nothing else;
 * `press` takes a card id and a key, and nothing in a request can name a
 * household, a person, or a word that is shown to anyone.
 *
 * INV-2: whatever reaches the resident's television — an answer, a wave,
 * "… is ready to watch with you" — goes through the senders the server was
 * given (server.ts AppDeps), which in a deployment are egress.ts's. Nothing
 * here holds a transport.
 *
 * Asking for the home screen is a look, and she is told (tools/lookIn.ts).
 * Asking for the seat or for what waits is not: neither reads anything of
 * her day, and neither writes anything at all.
 *
 * No model is called, and nothing is logged that came out of a token.
 */
import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DOOR_ANSWERS,
  FAMILY_TV_PRESSES,
  FAMILY_TV_SK_PREFIX,
  FAMILY_TV_WAITING_SCOPE,
  FAMILY_TV_WAVE_CARD,
  PAIRING_PUBLIC_KEY_ROW,
  currentIsoWeek,
  familyTvCardId,
  isDoorAnswer,
  isFamilyTelevisionToken,
  isReachAnswer,
  isWatchAnswer,
  isWatchSessionId,
  parseFamilyTvCardId,
  type CardAction,
  type CardPatch,
  type FamilyTvCard,
  type FamilyTvHome,
  type FamilyTvPressResult,
  type FamilyTvSeatReply,
  type FamilyTvWaiting,
  type QueuedCard,
} from '@wick/contracts';
import { answerDoorRequest } from '../tools/answer_door_request.js';
import { answerReachRequest } from '../tools/answer_reach_request.js';
import { answerWatchTogether } from '../tools/answer_watch_together.js';
import { neighbourRefusal } from '../tools/context.js';
import { loadDoorRequest, loadLookRow } from '../tools/get_door_request.js';
import { loadLight } from '../tools/get_light.js';
import { loadLatestWeek, type LatestWeekResult } from '../tools/get_week_narrative.js';
import { sitDownToWatch } from '../tools/join_watch_together.js';
import { mySessions } from '../tools/watchSession.js';
import { firstName, reachFor, reachesOf } from '../tools/get_reach_request.js';
import { isSharedWithFamily, loadHouseholdPolicy } from '../tools/get_resident_shared_view.js';
import { recordLook, type SendHome } from '../tools/lookIn.js';
import type { AnswerOutcome } from '../tools/result.js';
import type { HouseholdPolicy } from '@wick/policy';
import { checkAccess } from './circle.js';
import type { AccountStore } from './store.js';
import { action, type TvCaller } from './familyTvTypes.js';
import { watchCard, watchSeat } from './familyTvWatch.js';
import { WAVE_ID, loadWave, markWaveSeen, sendWave, waveBackCard, waveButton } from './familyTvWave.js';
import { WEEK_ID, markWeekRead, readableWeek, weekCard } from './familyTvWeek.js';

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
/**
 * How long after a television asked for its home screen its app is taken to
 * be on screen still, and its background service told that nothing waits:
 * the app is showing the cards itself, and a notice over it would say each
 * thing twice. The app asks every eight seconds; the service every twenty.
 */
export const ON_SCREEN_FOR_MS = 20_000;
/**
 * How long the look-up of her weeks is kept for a television. Her weeks
 * change once a week and are asked after every eight seconds; a week she
 * has just read on her own television is offered here within this long.
 */
export const WEEK_LOOKUP_KEPT_MS = 60_000;
/** More televisions than this at once and the one heard from longest ago is forgotten: a notice it did not need, or one read more, at worst. */
const MAX_TELEVISIONS_REMEMBERED = 10_000;

/** Keeps `value` for `key`, newest last, and lets the oldest go when there are too many. */
function remember<V>(kept: Map<string, V>, key: string, value: V): void {
  // Taken out first, so the map stays in the order its keys were last set.
  kept.delete(key);
  kept.set(key, value);
  if (kept.size > MAX_TELEVISIONS_REMEMBERED) kept.delete(kept.keys().next().value as string);
}
/** Never more than three (AGENTS.md: three items, never four). */
const MAX_CARDS = 3;
/** A device token is a few hundred characters. Anything far longer is not one, and is not parsed. */
const MAX_AUTHORIZATION_CHARS = 4096;
/** The limits the tools put on the same ids (answer_door_request, answer_reach_request). */
const MAX_DOOR_REQUEST_ID_CHARS = 64;
const REACH_REQUEST_ID = /^\d{13,16}$/;

/** `Bearer <header>.<payload>.<signature>`, each part base64url and nothing else. */
const BEARER = /^Bearer +([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/i;

/** The three things that can be said about who is at the door, each the sentence itself. */
const DOOR_ACTIONS: readonly CardAction[] = Object.entries(DOOR_ANSWERS).map(([key, text], index) => action(key, text, index));

/**
 * The order of a home screen, most pressing first: what waits for this
 * member's answer — the door, her asking to be rung, a film to sit down to
 * — then a wave that came back, then what became of something lately
 * answered, then a film still ahead, and her week last.
 */
const RANK = { door: 0, reach: 1, film: 2, waveBack: 3, settled: 4, filmAhead: 5, week: 6 } as const;

interface Ranked {
  readonly rank: number;
  readonly card: FamilyTvCard;
}

const ranked = (rank: number, card: FamilyTvCard | undefined): Ranked | undefined => (card ? { rank, card } : undefined);

/** The cards of a home screen in order, and never more than three. */
const inOrder = (cards: readonly (Ranked | undefined)[]): FamilyTvCard[] =>
  cards
    .filter((entry): entry is Ranked => entry !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_CARDS)
    .map((entry) => entry.card);

export interface FamilyTelevisionDeps {
  /** The household's own rows, as the tools read them. */
  readonly ddb: DynamoDBClient;
  readonly store: AccountStore;
  /** egress.ts's sendToDevice — how an answer to a request to ring reaches the resident's television (INV-2). */
  readonly sendCard: (card: QueuedCard) => Promise<void>;
  /** egress.ts's sendPatchToDevice — how an answer reaches the door card (INV-2). */
  readonly sendPatch: (patch: CardPatch, householdId: string) => Promise<void>;
  /** egress.ts's takeBackFromDevices — how a wave that is being replaced leaves the resident's television (INV-2). */
  readonly withdrawCard: (householdId: string, cardId: string) => Promise<void>;
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
  | 'wrong_scope'
  | 'no_row'
  | 'denylisted'
  | 'not_this_members'
  | 'not_allowed'
  | 'neighbour';

/** What a refused television is sent. `say` is a sentence it can show as it stands. */
export interface TvRefusal {
  readonly error: 'invalid_token' | 'token_expired' | 'wrong_scope' | 'television_not_connected' | 'not_a_family_television' | 'not_allowed' | 'bad_card' | 'bad_action';
  readonly say?: string;
}

export type TvReply<T> =
  | { readonly status: 200; readonly body: T }
  | { readonly status: 400 | 401 | 403; readonly body: TvRefusal; readonly reason?: TvRefusalReason };

type Refused = Extract<TvReply<never>, { body: TvRefusal }>;

type Caller = TvCaller;

export interface FamilyTelevisionEndpoints {
  /** `GET /tv/home`. Takes the Authorization header and nothing else. */
  home(authorization: string | undefined): Promise<TvReply<FamilyTvHome>>;
  /** `POST /tv/press`. Takes the Authorization header and the request's JSON body. */
  press(authorization: string | undefined, body: unknown): Promise<TvReply<FamilyTvPressResult>>;
  /** `GET /tv/seat`. Takes the Authorization header and nothing else; it is not a look, and writes nothing. */
  seat(authorization: string | undefined): Promise<TvReply<FamilyTvSeatReply>>;
  /** `GET /tv/waiting`. Takes the Authorization header and nothing else; notes nothing and writes nothing. */
  waiting(authorization: string | undefined): Promise<TvReply<FamilyTvWaiting>>;
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
   * When each television last asked for its home screen. In this process's
   * memory and nowhere else: nothing is written for it, a restart forgets
   * it, and a second instance would not share it — each of which costs at
   * most one notice over an app that is already showing the same thing.
   * One instance serves the deployment (infra/mcp.tf).
   */
  const lastHomeAt = new Map<string, number>();
  const screenOf = (who: Caller): string => `${who.householdId}/${who.deviceId}`;
  const noteOnScreen = (who: Caller): void => remember(lastHomeAt, screenOf(who), now());
  const isOnScreen = (who: Caller): boolean => {
    const at = lastHomeAt.get(screenOf(who));
    return at !== undefined && now() - at < ON_SCREEN_FOR_MS;
  };

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

  /**
   * `forWaiting`: the route is `/tv/waiting`, the one thing the television's
   * background service may ask. Its token says so (`scope: 'waiting'`) and
   * is taken there and nowhere else; the television's ordinary token, which
   * carries no scope at all, is taken everywhere.
   */
  async function authenticate(authorization: string | undefined, forWaiting = false): Promise<Caller | Refused> {
    const verified = await verifiedClaims(authorization);
    if ('status' in verified) return verified;
    const { claims } = verified;
    // The resident's own television, or anything else the pairing key signed: not a way in here, and nothing is read for it.
    if (!isFamilyTelevisionToken(claims)) return refuse(403, 'not_a_family_television', 'not_family');
    // A token that names a scope is good for that scope's one route. Any other scope, on any route, is good for nothing.
    if ('scope' in claims && !(forWaiting && claims.scope === FAMILY_TV_WAITING_SCOPE)) return refuse(401, 'wrong_scope', 'wrong_scope');
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
    const weekRead = row.weekRead?.S;
    return { householdId, userId, deviceId, membership: access.membership, household: access.household, ...(weekRead ? { weekRead } : {}) };
  }

  /** Her light in one sentence — and the look that asking for it is. Undefined when she keeps the shape of her day to herself. */
  async function lightFor(who: Caller, at: number, policy: HouseholdPolicy): Promise<FamilyTvHome['light']> {
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

  /**
   * Her question from the door. `settled`: also what became of one lately
   * answered — for the home screen, not for what is waiting.
   */
  async function doorCard(who: Caller, at: number, settled: boolean): Promise<Ranked | undefined> {
    const request = await loadDoorRequest(ddb, who.householdId, at);
    if (!request) return undefined;
    const id = familyTvCardId('door_look', request.requestId);

    if (request.state === 'waiting') {
      return ranked(RANK.door, {
        id,
        kind: 'door_look',
        headline: `${who.household.residentName} has asked you to look at the door.`,
        detail: request.description ?? request.line,
        ...(request.pictureUrl ? { pictureUrl: request.pictureUrl } : {}),
        actions: DOOR_ACTIONS,
      });
    }
    if (settled && request.state === 'answered' && at - request.answer.at < SETTLED_SHOWN_MS) {
      // Who answered is on the row, not in what the tool hands out. The member
      // who answered was told so in the sentence their press came back with;
      // a card saying it again is one more thing to put away, and it would
      // come back each time the television is started. Everyone else is told who.
      const row = await loadLookRow(ddb, who.householdId, request.requestId);
      if (row?.answeredBy?.S === who.userId) return undefined;
      return ranked(RANK.settled, { id, kind: 'door_look', headline: `${request.answer.by} answered: “${request.answer.text}”`, actions: [] });
    }
    // Gone from her television unanswered, or settled a while ago.
    return undefined;
  }

  /** Her asking to be rung, for somebody it has reached. `settled` as for the door. */
  async function reachCard(who: Caller, at: number, settled: boolean): Promise<Ranked | undefined> {
    // Undefined for somebody not asked, exactly as for no request at all: nobody learns of her asking before their turn.
    const reach = reachFor(await reachesOf(ddb).latest(who.householdId), who.userId, who.household.residentName, at);
    if (!reach) return undefined;
    const id = familyTvCardId('reach', reach.requestId);

    if (reach.state === 'waiting') {
      return ranked(RANK.reach, {
        id,
        kind: 'reach',
        headline: reach.summary,
        ...(reach.kind === 'ring' ? { detail: 'This does not make the call. Ring her yourself.' } : {}),
        actions: reach.answers.map(({ key, text }, index) => action(key, text, index)),
      });
    }
    // As at the door: nothing more for the member who answered, the name for everyone else.
    if (settled && !reach.answer.yours && at - reach.answer.at < SETTLED_SHOWN_MS) {
      return ranked(RANK.settled, { id, kind: 'reach', headline: `${reach.answer.by} answered: “${reach.answer.text}”`, actions: [] });
    }
    return undefined;
  }

  /**
   * Her weeks as last looked up for each television: the newest she has
   * read (INV-7), before anything she keeps private is applied — that is
   * applied afresh on every asking (familyTvWeek.ts readableWeek). Kept in
   * this process's memory for a minute and nowhere else, like `lastHomeAt`:
   * a restart or a second instance costs one read more. Who is asking is
   * still settled on every call; this spares only the read of her weeks.
   */
  const weekLookups = new Map<string, { readonly at: number; readonly currentWeek: string; readonly latest: LatestWeekResult }>();
  async function latestWeek(who: Caller, at: number): Promise<LatestWeekResult> {
    const currentWeek = currentIsoWeek(new Date(at));
    const kept = weekLookups.get(screenOf(who));
    if (kept && kept.currentWeek === currentWeek && at - kept.at < WEEK_LOOKUP_KEPT_MS) return kept.latest;
    const latest = await loadLatestWeek(ddb, who.householdId, currentWeek);
    remember(weekLookups, screenOf(who), { at, currentWeek, latest });
    return latest;
  }

  /** A film this member arranged with her — and only this member (tools/watchSession.ts mySessions). One read. */
  const filmCard = async (who: Caller, at: number) => watchCard(who, await mySessions(ddb, who.householdId, who.userId), at);

  async function homeFor(who: Caller): Promise<FamilyTvHome> {
    const at = now();
    // Read once, for the two things it decides: her light and her week.
    const policy = loadHouseholdPolicy(ddb, who.householdId);
    const [light, week, door, reach, film, wave] = await Promise.all([
      policy.then((shared) => lightFor(who, at, shared)),
      policy.then((shared) => readableWeek(shared, () => latestWeek(who, at))),
      doorCard(who, at, true),
      reachCard(who, at, true),
      filmCard(who, at),
      loadWave(ddb, who, at),
    ]);
    return {
      residentName: who.household.residentName,
      memberName: firstName(who.membership.name),
      ...(light ? { light } : {}),
      cards: inOrder([door, reach, film && ranked(film.card.actions.length > 0 ? RANK.film : film.settled ? RANK.settled : RANK.filmAhead, film.card), ranked(RANK.waveBack, waveBackCard(who, wave, at)), ranked(RANK.week, weekCard(who, week))]),
      wave: waveButton(who, wave, at),
      ...(who.household.simulated ? { simulated: true as const } : {}),
    };
  }

  /**
   * What waits for this member's answer, and a wave that came back — for a
   * television whose app is off the screen. Nobody is looking, so nothing
   * of her day is read (no light, no week, no policy), no look is noted,
   * and nothing is written. Each line is the card's own headline.
   */
  async function waitingFor(who: Caller): Promise<FamilyTvWaiting> {
    const at = now();
    const [door, reach, film, wave] = await Promise.all([doorCard(who, at, false), reachCard(who, at, false), filmCard(who, at), loadWave(ddb, who, at)]);
    return {
      waiting: inOrder([door, reach, film?.timeToSit ? ranked(RANK.film, film.card) : undefined, ranked(RANK.waveBack, waveBackCard(who, wave, at))])
        .map((card) => ({ id: card.id, line: card.headline })),
    };
  }

  /**
   * The seat beside her film: for the member who invited her and has sat
   * down, and empty for everyone else and at every other time — the same
   * shape as there being no film. Asked every couple of seconds by a seated
   * television, so it is one read; and it is not a look.
   */
  async function seatFor(who: Caller): Promise<FamilyTvSeatReply> {
    const seat = watchSeat(who, await mySessions(ddb, who.householdId, who.userId), now());
    return seat ? { seat } : {};
  }

  /** The member's press as one sentence: it is on her television, or why it is not (§6.4: a refusal is an answer). */
  const pressed = (outcome: AnswerOutcome): TvReply<FamilyTvPressResult> => ({
    status: 200,
    body: outcome.shown
      ? { done: true, say: `It is on the television now: “${outcome.by} says: ${outcome.text}”` }
      : { done: false, say: outcome.say },
  });

  const said = (done: boolean, say: string): TvReply<FamilyTvPressResult> => ({ status: 200, body: { done, say } });
  const BAD_CARD: TvReply<FamilyTvPressResult> = { status: 400, body: { error: 'bad_card' } };
  const BAD_ACTION: TvReply<FamilyTvPressResult> = { status: 400, body: { error: 'bad_action' } };

  /**
   * "I have read it", sent when the last page is turned. It counts only for
   * the week the family may read now — so a week still waiting on her
   * television is answered exactly as one that was never written (INV-7).
   */
  async function weekRead(who: Caller, isoWeek: string): Promise<TvReply<FamilyTvPressResult>> {
    // Looked up afresh, not from what is kept: a press is decided on how things stand. And what is kept goes.
    weekLookups.delete(screenOf(who));
    const at = now();
    const week = await readableWeek(await loadHouseholdPolicy(ddb, who.householdId), () => loadLatestWeek(ddb, who.householdId, currentIsoWeek(new Date(at))));
    if (week?.isoWeek !== isoWeek) return said(false, 'That week is not here to read.');
    if (!(await markWeekRead(ddb, who, isoWeek))) return said(false, 'This television is no longer connected.');
    return said(true, `You have read ${who.household.residentName}’s week.`);
  }

  async function pressFor(who: Caller, body: unknown): Promise<TvReply<FamilyTvPressResult>> {
    // A card and an answer's key: all a press may carry. Anything else in the body is never looked at (INV-8).
    const { cardId, action: chosen } = (typeof body === 'object' && body !== null ? body : {}) as { cardId?: unknown; action?: unknown };
    const card = parseFamilyTvCardId(cardId);
    if (!card) return BAD_CARD;
    const answerer = { householdId: who.householdId, userId: who.userId, memberName: who.membership.name, residentName: who.household.residentName };

    switch (card.kind) {
      case 'door_look':
        if (card.requestId.length > MAX_DOOR_REQUEST_ID_CHARS) return BAD_CARD;
        if (!isDoorAnswer(chosen)) return BAD_ACTION;
        return pressed(await answerDoorRequest(ddb, answerer, card.requestId, chosen, deps.sendPatch, now()));

      case 'reach':
        if (!REACH_REQUEST_ID.test(card.requestId)) return BAD_CARD;
        if (!isReachAnswer(chosen)) return BAD_ACTION;
        return pressed(await answerReachRequest(ddb, answerer, card.requestId, chosen, deps.sendCard, now()));

      case 'week':
        if (!WEEK_ID.test(card.requestId)) return BAD_CARD;
        if (chosen !== FAMILY_TV_PRESSES.read) return BAD_ACTION;
        return weekRead(who, card.requestId);

      case 'watch': {
        if (!isWatchSessionId(card.requestId)) return BAD_CARD;
        const watcher = { householdId: who.householdId, userId: who.userId, residentName: who.household.residentName };
        if (chosen === FAMILY_TV_PRESSES.sit) {
          const sat = await sitDownToWatch(ddb, watcher, card.requestId, deps.sendCard, now());
          if (!sat.sat) return said(false, sat.say);
          return said(true, sat.already ? 'You have already sat down.' : `You have sat down. ${watcher.residentName}’s television says you are ready.`);
        }
        if (!isWatchAnswer(chosen)) return BAD_ACTION;
        return pressed(await answerWatchTogether(ddb, watcher, card.requestId, chosen, deps.sendCard, now()));
      }

      case 'wave': {
        const resident = who.household.residentName;
        if (cardId === FAMILY_TV_WAVE_CARD) {
          if (chosen !== FAMILY_TV_PRESSES.wave) return BAD_ACTION;
          return (await sendWave(ddb, deps, who, now()))
            ? said(true, `Your wave is on its way to ${resident}’s television. It will wait for a quiet moment.`)
            : said(false, `Your wave is still on its way to ${resident}’s television. You can wave again in a few minutes.`);
        }
        if (!WAVE_ID.test(card.requestId)) return BAD_CARD;
        if (chosen !== FAMILY_TV_PRESSES.seen) return BAD_ACTION;
        return (await markWaveSeen(ddb, who, card.requestId, now())) ? said(true, `${resident} waved back.`) : said(false, 'That wave is not here any more.');
      }

      default:
        return BAD_CARD;
    }
  }

  return {
    async home(authorization) {
      const who = await authenticate(authorization);
      if ('status' in who) return who;
      const body = await homeFor(who);
      noteOnScreen(who);
      return { status: 200, body };
    },
    async press(authorization, body) {
      const who = await authenticate(authorization);
      if ('status' in who) return who;
      return pressFor(who, body);
    },
    async seat(authorization) {
      const who = await authenticate(authorization);
      if ('status' in who) return who;
      return { status: 200, body: await seatFor(who) };
    },
    async waiting(authorization) {
      const who = await authenticate(authorization, true);
      if ('status' in who) return who;
      // Its app is on screen and showing all of this itself: nothing to say over it, and nothing read to find out.
      if (isOnScreen(who)) return { status: 200, body: { waiting: [] } };
      return { status: 200, body: await waitingFor(who) };
    },
  };
}
