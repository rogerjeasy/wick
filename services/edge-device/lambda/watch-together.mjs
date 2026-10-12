/**
 * Watch together, the television's half (packages/contracts/src/watch.ts).
 *
 * Everything the resident does in a session arrives here as a press or as
 * her player saying where the film is:
 *
 *   - yes or no on the invitation;
 *   - "Start the film" or "Not now" on the card that says someone is ready;
 *   - where the film is, every few seconds, from that Start press on;
 *   - her answer to the one question at the credits.
 *
 * The rule in watch.ts is kept by the conditions below, not by trusting the
 * television. A position is kept only against a session she started, only
 * for the film that session names, and only while it is open — so a
 * television that sent every film she ever played would still be telling
 * nobody anything. And the household is the connection's own (INV-8): a
 * television can only ever speak about the home it is in.
 *
 * This plain .mjs Lambda can't import TS; the constants are inlined from
 * packages/contracts/src/watch.ts (WATCH_SK_PREFIX, watchCardId,
 * WATCH_ACTIONS, WATCH_ANSWERS, WATCH_QUESTION) — watch-together.test.ts
 * holds them to it.
 *
 * Pure: device-event.mjs owns the DynamoDB client.
 */

const SK_PREFIX = 'WATCH#';
const WATCH_CARD_ID = /^watch-(invite|ready|question)-([A-Za-z0-9_-]{1,64})$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['PLAYING', 'PAUSED', 'STOPPED', 'BUFFERING']);

export const QUESTION = 'What did you think of it?';
export const ANSWERS = {
  loved_it: 'I loved it.',
  all_right: 'It was all right.',
  not_for_me: 'Not really for me.',
};

/** The buttons each card has, and what pressing one means. */
const PRESSES = {
  invite: { accept: 'accept', decline: 'decline' },
  ready: { start: 'start', not_now: 'not_now' },
};

const key = (householdId, sessionId) => ({ pk: { S: `HH#${householdId}` }, sk: { S: `${SK_PREFIX}${sessionId}` } });

/** Which session a press is about, and what the resident said — or undefined when it is not one of these cards' buttons. */
export function watchPress(cardId, action) {
  const match = typeof cardId === 'string' ? WATCH_CARD_ID.exec(cardId) : null;
  if (!match || typeof action !== 'string') return undefined;
  const [, kind, sessionId] = match;
  if (kind === 'question') return Object.hasOwn(ANSWERS, action) ? { sessionId, press: 'answer', answer: action } : undefined;
  const press = Object.hasOwn(PRESSES[kind], action) ? PRESSES[kind][action] : undefined;
  return press ? { sessionId, press } : undefined;
}

/** UpdateItem input for her yes or no. Only an invitation still waiting can be answered. */
export function decisionUpdate({ table, householdId, sessionId, accepted, at }) {
  return {
    TableName: table,
    Key: key(householdId, sessionId),
    UpdateExpression: 'SET #status = :status, decidedAt = :at',
    ConditionExpression: '#status = :invited',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': { S: accepted ? 'accepted' : 'declined' }, ':invited': { S: 'invited' }, ':at': { N: String(at) } },
  };
}

/**
 * UpdateItem input for "Start the film": the press from which the family
 * member's player may follow hers. The first press is the start; a session
 * nobody has sat down to, that she passed on, or that is over cannot be started.
 */
export function startUpdate({ table, householdId, sessionId, at }) {
  return {
    TableName: table,
    Key: key(householdId, sessionId),
    UpdateExpression: 'SET startedAt = if_not_exists(startedAt, :at)',
    ConditionExpression: '#status = :accepted AND attribute_exists(joinedAt) AND attribute_not_exists(passedAt) AND closesAt > :at',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':accepted': { S: 'accepted' }, ':at': { N: String(at) } },
  };
}

/** UpdateItem input for "Not now" on the ready card. */
export function notNowUpdate({ table, householdId, sessionId, at }) {
  return {
    TableName: table,
    Key: key(householdId, sessionId),
    UpdateExpression: 'SET passedAt = :at',
    ConditionExpression: '#status = :accepted AND attribute_not_exists(startedAt) AND attribute_not_exists(passedAt)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':accepted': { S: 'accepted' }, ':at': { N: String(at) } },
  };
}

/**
 * UpdateItem input keeping where the film is — or undefined when the event
 * is not a position at all.
 *
 * `pbAt` is this server's clock, not the television's: the family member's
 * player works out how far the film has moved on since, and two clocks that
 * disagree must not move it. The television's own `at` only orders its
 * events, so one retried late cannot wind the film back.
 */
export function positionUpdate({ table, householdId, event, now }) {
  if (typeof event?.sessionId !== 'string' || !SESSION_ID.test(event.sessionId)) return undefined;
  if (!STATES.has(event.state) || typeof event.contentId !== 'string' || !event.contentId) return undefined;
  if (typeof event.positionMs !== 'number' || !Number.isFinite(event.positionMs) || event.positionMs < 0) return undefined;
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return undefined;
  return {
    TableName: table,
    Key: key(householdId, event.sessionId),
    UpdateExpression: 'SET pbState = :state, pbPositionMs = :position, pbAt = :now, pbDeviceAt = :deviceAt',
    ConditionExpression:
      'attribute_exists(startedAt) AND programmeId = :content AND closesAt > :now AND (attribute_not_exists(pbDeviceAt) OR pbDeviceAt <= :deviceAt)',
    ExpressionAttributeValues: {
      ':state': { S: event.state },
      ':position': { N: String(Math.round(event.positionMs)) },
      ':now': { N: String(now) },
      ':deviceAt': { N: String(Math.round(event.at)) },
      ':content': { S: event.contentId },
    },
    ReturnValues: 'ALL_NEW',
  };
}

/** Whether the session row, as a position has just left it, has reached the credits unasked. */
export function shouldAsk(item) {
  const credits = Number(item?.creditsMs?.N);
  const position = Number(item?.pbPositionMs?.N);
  if (!item || item.askedAt || !Number.isFinite(credits) || !Number.isFinite(position)) return false;
  return position >= credits;
}

/** UpdateItem input claiming the question: whoever sets `askedAt` first sends the card. */
export function askedUpdate({ table, householdId, sessionId, at }) {
  return {
    TableName: table,
    Key: key(householdId, sessionId),
    UpdateExpression: 'SET askedAt = :at',
    ConditionExpression: 'attribute_not_exists(askedAt)',
    ExpressionAttributeValues: { ':at': { N: String(at) } },
  };
}

/**
 * The question at the credits, as a card. DEFERRED like every card but the
 * door's: the credits are a natural break, so it is shown as they begin and
 * never over the story (INV-5).
 */
export function buildQuestionCard({ householdId, item, now }) {
  const sessionId = item.sessionId.S;
  const withName = item.invitedByName?.S ?? 'your family';
  const id = `watch-question-${sessionId}`;
  return {
    id,
    urgency: 'DEFERRED',
    queuedAt: now,
    shownCount: 0,
    card: {
      type: 'WATCH',
      id,
      householdId,
      correlationId: `watch-${sessionId}`,
      createdAt: now,
      sessionId,
      withName,
      headline: `That was ${item.programmeTitle?.S ?? 'the film'}, with ${withName}.`,
      detail: QUESTION,
      actions: Object.entries(ANSWERS).map(([answer, label], i) => ({ id: answer, label, kind: i === 0 ? 'primary' : 'secondary' })),
    },
  };
}

/** UpdateItem input for her answer. The first answer is the answer. */
export function answerUpdate({ table, householdId, sessionId, answer, at }) {
  if (!Object.hasOwn(ANSWERS, answer)) throw new Error('not an answer Wick offered');
  return {
    TableName: table,
    Key: key(householdId, sessionId),
    UpdateExpression: 'SET residentAnswer = :answer, residentAnsweredAt = :at',
    ConditionExpression: 'attribute_exists(askedAt) AND attribute_not_exists(residentAnswer)',
    ExpressionAttributeValues: { ':answer': { S: answer }, ':at': { N: String(at) } },
  };
}
