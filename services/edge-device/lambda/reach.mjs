/**
 * Hold for Sarah, the television's half (packages/contracts/src/reach.ts).
 *
 * She held OK for two seconds. This answers on the television that was
 * held, with one of two things:
 *
 *   - a request already under way, as it now stands — the stored card the
 *     agent plane last wrote (services/agent agents/reach), so holding the
 *     button again never asks a second time; or
 *   - the offer: "Ask Sarah to ring you?", naming the one person who would
 *     be asked first, read from her circle as it stands at this moment.
 *
 * Nothing is filed here and nobody is told anything: only her press on the
 * card does that, and the agent plane carries it out (card-action-event.mjs
 * hands `ring_me` and `say_hello` on). The offer is not stored either — it
 * is hers to look at, not something she is owed.
 *
 * This plain .mjs Lambda can't import TS; the names, the order of asking
 * and the card's words below are inlined from packages/contracts/src/
 * reach.ts, and reach.test.ts holds them to it.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */

export const REACH_SK_PREFIX = 'REACH#';
export const REACH_ACTIONS = { ring: 'ring_me', hello: 'say_hello', notNow: 'not_now', ok: 'ok' };

/** contracts REACH_UNDER_WAY_MS. */
const REACH_UNDER_WAY_MS = 30 * 60_000;
const MEMBER_SK_PREFIX = 'MEM#';
const ROLE_RANK = { organiser: 0, family: 1, neighbour: 2 };

export function isReachEvent(deviceEvent) {
  return deviceEvent?.t === 'reach';
}

/** Query input for the household's newest request: ids are moments, so the last key is the latest. */
export function latestReach({ table, householdId }) {
  return {
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: REACH_SK_PREFIX } },
    ScanIndexForward: false,
    Limit: 1,
    // An answer given a moment ago must count: otherwise she is shown a wait that is over.
    ConsistentRead: true,
  };
}

/**
 * The id of a request still under way, from its row — or undefined when
 * there is none to show: answered, everyone asked in vain, or so long ago
 * that the asking must have gone wrong (contracts reachUnderWay).
 */
export function reachUnderWayId(item, now) {
  const reachId = item?.reachId?.S;
  const askedAt = Number(item?.askedAt?.N);
  if (!reachId || !Number.isFinite(askedAt)) return undefined;
  if (item.answeredAt || item.doneAt) return undefined;
  return now - askedAt < REACH_UNDER_WAY_MS ? reachId : undefined;
}

/** Where the agent plane keeps that request's card (egress.ts cardItem; contracts reachCardId). */
export function storedCardKey(householdId, reachId) {
  return { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#reach-${reachId}` } };
}

/**
 * Who would be asked first, from the household's rows: the organiser, then
 * the family in the order they came to her circle, a neighbour last
 * (contracts reachOrder). Only somebody she allows.
 */
export function firstToAsk(items) {
  return items
    .filter((item) => item.sk?.S?.startsWith(MEMBER_SK_PREFIX) && item.status?.S === 'allowed' && item.name?.S)
    .map((item) => ({
      userId: item.sk.S.slice(MEMBER_SK_PREFIX.length),
      name: item.name.S,
      role: item.role?.S in ROLE_RANK ? item.role.S : 'family',
      since: Number(item.requestedAt?.N ?? 0),
    }))
    .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.since - b.since || a.userId.localeCompare(b.userId))
    .map(({ userId, name, role }) => ({ userId, name, role }))[0];
}

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'Someone';

/** The card her hold brings (contracts buildReachAskCard, word for word). */
export function buildReachAskCard({ householdId, reachId, first, now }) {
  const id = `reach-${reachId}`;
  const name = first ? firstName(first.name) : undefined;
  const words = name
    ? {
        headline: `Ask ${name} to ring you?`,
        detail: `${name} will be told only that you would like a call. Wick does not call for help: in an emergency, use the telephone.`,
        actions: [
          { id: REACH_ACTIONS.ring, label: `Yes, ask ${name}`, kind: 'primary' },
          { id: REACH_ACTIONS.hello, label: 'Just say hello', kind: 'secondary' },
          { id: REACH_ACTIONS.notNow, label: 'No, not now', kind: 'dismiss' },
        ],
      }
    : {
        headline: 'There is nobody Wick can ask just now.',
        detail: 'When you have allowed someone in your family circle, you can ask them here to ring you.',
        actions: [{ id: REACH_ACTIONS.ok, label: 'All right', kind: 'primary' }],
      };
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: { type: 'REACH', id, householdId, correlationId: id, createdAt: now, ...words },
  };
}
