/**
 * The visit pass, the edge's half (packages/contracts visitPass.ts).
 *
 *   POST /visit/status {token}        -> {state, says?, at?, lateMinutes?}
 *   POST /visit/say    {token, says}  -> the same, once what was said is kept
 *
 * The visitor a family member arranged opens the link the member forwarded
 * (the family app's visit.html, the token after `#`) and presses one of
 * three buttons: on my way, running late, I'm at the door. This is what
 * those presses reach. It is the one route on the edge that somebody with
 * no account at all may change anything through, so it can do exactly one
 * thing: keep one of three words on one visit, inside that visit's hours.
 *
 *   the token's sha-256 -> VPASS#<hash>               which visit; the token itself is kept nowhere
 *   HH#<household> / ERRAND#<errandId>                the visit, still open, and the pass still its own
 *   HH#<household> / MEM#<author>                     the member who arranged it, still allowed (INV-9)
 *   presses += 1, under VISIT_PASS_LIMITS.maxPresses  three buttons do not need more
 *   visitorWord on the errand row and its roster row  what her day and the door read
 *   one PutEvents:
 *     wick.device / home.changed   her day, whole, for every television of the home (agent egress.ts)
 *     wick.visit / visit.said      the member is nudged; a door card already up is told (agent visit/said.ts)
 *
 * No oracle. A token that is not one, one nobody holds, a visit that was
 * called off or has ended, a member she no longer allows, a pass made
 * again since, a visit whose hours are over — every one answers 200
 * `{ state: 'over' }`, the same words in the same shape, so the page can
 * tell a visitor nothing about the house and a guesser learns nothing. Only
 * "not yet" is said apart, and only to a pass that is real.
 *
 * The answer names nobody: not the resident, the member, the household,
 * the address or the visitor. What was last said, and when, is all.
 *
 * The token is never logged, and neither is its hash: either would let
 * whoever reads a log press the buttons. A line names the errand and what
 * was said.
 *
 * This plain .mjs Lambda can't import TS; what it needs of
 * packages/contracts visitPass.ts and errand.ts is inlined below, and
 * __tests__/visit-pass.test.ts holds it to them.
 *
 * `createHandler` takes its DynamoDB send, its bus and its clock, so it is
 * tested without AWS (__tests__/visit-pass.test.ts).
 */
import { createHash } from 'node:crypto';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { buildHomeChangedEntry } from './light.mjs';
import { readHome } from './home.mjs';
import { VISIT_PASS_LIMITS, isVisitorSays, visitorWordOfRow } from './visitor-word.mjs';

/** contracts visitPass.ts VISIT_PASS_PK_PREFIX, VISIT_PASS_SK. */
export const VISIT_PASS_PK_PREFIX = 'VPASS#';
export const VISIT_PASS_SK = 'VPASS';
/** contracts visitPass.ts VISIT_EVENTS. */
export const VISIT_EVENTS = { source: 'wick.visit', said: 'visit.said' };
/** contracts errand.ts errandSk / errandPersonId. */
const ERRAND_SK_PREFIX = 'ERRAND#';
const ERRAND_PERSON_PREFIX = 'errand:';
/**
 * The statuses a pass still speaks for: a visit still waiting for its
 * visitor, and one whose door has rung — the doctor may press "I'm at the
 * door" a moment after ringing. Called off, failed, or no one came: over.
 */
export const PASS_SPEAKS_FOR = ['planned', 'reminded', 'waiting', 'rang'];

/** contracts visitPass.ts isVisitPassToken: 128 random bits as 32 lower-case hex characters. */
const TOKEN = /^[0-9a-f]{32}$/;
export const isVisitPassToken = (value) => typeof value === 'string' && TOKEN.test(value);

/** contracts visitPass.ts passStateAt. */
export function passStateAt(visit, now) {
  if (now < visit.at - VISIT_PASS_LIMITS.opensBeforeMs) return 'not_yet';
  if (now > visit.at + visit.windowMinutes * 60_000) return 'over';
  return 'open';
}

/** contracts visitPass.ts nextLateMinutes. */
export function nextLateMinutes(current, windowMinutes) {
  return Math.min((current ?? 0) + VISIT_PASS_LIMITS.lateStepMinutes, windowMinutes);
}

/** A token's hash: the only way a pass is found. */
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

const numberOf = (attribute) => {
  const value = Number(attribute?.N);
  return attribute?.N !== undefined && Number.isFinite(value) ? value : undefined;
};

const refused = (err) => err?.name === 'ConditionalCheckFailedException';

const answer = (statusCode, body) => ({
  statusCode,
  // Nothing here is for a cache: a visitor who pressed must see what they pressed.
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
/** Every refusal, whatever it was: one answer, so none of them says which. */
const OVER = { state: 'over' };
const over = () => answer(200, OVER);

/** What the page is told of a word: what, when, and how late. Nothing else. */
const told = (word) => ({ state: 'open', ...(word ? { says: word.says, at: word.at, ...(word.lateMinutes ? { lateMinutes: word.lateMinutes } : {}) } : {}) });

/** The request's JSON body, or undefined. API Gateway may hand it over base64. */
function bodyOf(event) {
  try {
    const raw = event?.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event?.body;
    const body = JSON.parse(raw ?? '');
    return typeof body === 'object' && body !== null ? body : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `visit.said` entry for the bus (agent visit/said.ts readVisitSaidDetail).
 * Ids and the word only: the bus never carries who.
 */
export function buildVisitSaidEntry({ busName, householdId, errandId, says, at }) {
  return {
    EventBusName: busName,
    Source: VISIT_EVENTS.source,
    DetailType: VISIT_EVENTS.said,
    Detail: JSON.stringify({ householdId, errandId, says, at }),
  };
}

export function createHandler({ send, putEvents, table, busName, now = Date.now }) {
  /**
   * The pass a token opens, and the visit it is for — or why not. Every
   * read is consistent: a pass made again a moment ago, or a visit just
   * called off, must not still be answered for.
   */
  async function visitFor(token) {
    if (!isVisitPassToken(token)) return { refused: 'not_a_token' };
    const hash = tokenHash(token);
    const pass = (await send(new GetItemCommand({
      TableName: table,
      Key: { pk: { S: `${VISIT_PASS_PK_PREFIX}${hash}` }, sk: { S: VISIT_PASS_SK } },
      ConsistentRead: true,
    }))).Item;
    const householdId = pass?.householdId?.S;
    const errandId = pass?.errandId?.S;
    if (!householdId || !errandId) return { refused: 'unknown_pass' };

    const errandRow = (await send(new GetItemCommand({
      TableName: table,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `${ERRAND_SK_PREFIX}${errandId}` } },
      ConsistentRead: true,
    }))).Item;
    const at = numberOf(errandRow?.at);
    const windowMinutes = numberOf(errandRow?.windowMinutes);
    const createdBy = errandRow?.createdBy?.S;
    const status = errandRow?.status?.S;
    if (!errandRow || at === undefined || windowMinutes === undefined || !createdBy) return { refused: 'no_visit', errandId };
    if (!PASS_SPEAKS_FOR.includes(status)) return { refused: 'visit_ended', errandId };
    // A pass made again since (make_visit_pass) leaves this one's row behind only if deleting it failed: the visit says which is its own.
    if (errandRow.passHash?.S !== hash) return { refused: 'pass_replaced', errandId };

    // The visit stands on the word of the member who arranged it, for as long as she allows them (INV-9).
    const member = (await send(new GetItemCommand({
      TableName: table,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `MEM#${createdBy}` } },
      ProjectionExpression: '#s',
      ExpressionAttributeNames: { '#s': 'status' },
      ConsistentRead: true,
    }))).Item;
    if (member?.status?.S !== 'allowed') return { refused: 'author_not_allowed', errandId };

    return { hash, householdId, errandId, at, windowMinutes, word: visitorWordOfRow(errandRow) };
  }

  /** Her day has changed, and the agent plane is to hear what was said: one PutEvents. Logged, never thrown. */
  async function tell({ householdId, errandId, says, at }) {
    const entries = [];
    try {
      // Whole, as device-event.mjs tells it (home.mjs): every television of the home is told by the agent plane (egress.ts).
      const home = await readHome({ send, table, householdId, now: at, consistent: true });
      entries.push(buildHomeChangedEntry({ busName, householdId, home, at }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'visit_pass_home_unread', errandId, err: err?.name ?? 'unknown' }));
    }
    entries.push(buildVisitSaidEntry({ busName, householdId, errandId, says, at }));
    try {
      const res = await putEvents(entries);
      if (res?.FailedEntryCount) console.error(JSON.stringify({ level: 'error', msg: 'visit_said_publish_rejected', errandId, says, failed: res.FailedEntryCount }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'visit_said_publish_failed', errandId, says, err: err?.name ?? 'unknown' }));
    }
  }

  async function say(visit, says, at) {
    // Counted first, and only under the cap: a pass is three buttons, not a way to fill a table.
    try {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `${VISIT_PASS_PK_PREFIX}${visit.hash}` }, sk: { S: VISIT_PASS_SK } },
        UpdateExpression: 'ADD presses :one',
        ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(presses) OR presses < :max)',
        ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(VISIT_PASS_LIMITS.maxPresses) } },
      }));
    } catch (err) {
      if (!refused(err)) throw err;
      console.log(JSON.stringify({ level: 'warn', msg: 'visit_pass_busy', errandId: visit.errandId, says }));
      return answer(429, { state: 'open', busy: true });
    }

    const word = says === 'late'
      ? { says, at, lateMinutes: nextLateMinutes(visit.word?.says === 'late' ? visit.word.lateMinutes : undefined, visit.windowMinutes) }
      : { says, at };
    const value = { ':word': { S: JSON.stringify(word) } };

    // On the visit, only while it is still one a pass speaks for: a visit called off a moment ago is not written to.
    try {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `HH#${visit.householdId}` }, sk: { S: `${ERRAND_SK_PREFIX}${visit.errandId}` } },
        UpdateExpression: 'SET visitorWord = :word',
        ConditionExpression: `attribute_exists(pk) AND #s IN (${PASS_SPEAKS_FOR.map((_, i) => `:s${i}`).join(', ')})`,
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ...value, ...Object.fromEntries(PASS_SPEAKS_FOR.map((status, i) => [`:s${i}`, { S: status }])) },
      }));
    } catch (err) {
      if (!refused(err)) throw err;
      console.log(JSON.stringify({ level: 'info', msg: 'visit_pass_refused', why: 'visit_ended', errandId: visit.errandId }));
      return over();
    }

    // Beside the door's roster entry, as an attribute of its own so the entry is never rewritten
    // (agent store/visitorWord.ts) — and only while the door still expects them: a row is never made here.
    try {
      await send(new UpdateItemCommand({
        TableName: table,
        Key: { pk: { S: `HH#${visit.householdId}` }, sk: { S: `PER#${ERRAND_PERSON_PREFIX}${visit.errandId}` } },
        UpdateExpression: 'SET visitorWord = :word',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: value,
      }));
    } catch (err) {
      if (!refused(err)) throw err;
    }

    await tell({ householdId: visit.householdId, errandId: visit.errandId, says, at });
    console.log(JSON.stringify({ level: 'info', msg: 'visit_pass_said', errandId: visit.errandId, says }));
    return answer(200, told(word));
  }

  return async (event) => {
    const body = bodyOf(event);
    const saying = event?.routeKey === 'POST /visit/say';
    // What was said is checked before the token is looked at, so a bad word says nothing about the token.
    if (saying && !isVisitorSays(body?.says)) return answer(400, { error: 'says' });

    const visit = await visitFor(body?.token);
    if (visit.refused) {
      // Why, and the errand when one was found: never the token, never its hash.
      console.log(JSON.stringify({ level: 'info', msg: 'visit_pass_refused', why: visit.refused, ...(visit.errandId ? { errandId: visit.errandId } : {}) }));
      return over();
    }

    const at = now();
    const state = passStateAt(visit, at);
    if (state === 'over') return over();
    if (state === 'not_yet') return answer(200, { state: 'not_yet' });
    if (!saying) return answer(200, told(visit.word));
    return say(visit, body.says, at);
  };
}

const ddb = new DynamoDBClient({});
const events = new EventBridgeClient({});

export const handler = createHandler({
  send: (command) => ddb.send(command),
  putEvents: (entries) => events.send(new PutEventsCommand({ Entries: entries })),
  table: process.env.TABLE_NAME,
  busName: process.env.EVENT_BUS_NAME,
});
