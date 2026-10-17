/**
 * The server remembers what the resident already acted on, so reconcile
 * never hands it back.
 *
 * Reconcile's only other guard is the device's own `sinceCardId`
 * high-water mark — and on a device whose disk can't hold a write
 * (FRICTION.md FL-013) that is gone on every relaunch, so every card the
 * household ever received came back each time: the week card the resident
 * already read, the message they already answered. The server is the
 * durable record instead, the same move pair-refresh.mjs made for pairing
 * (FL-014).
 *
 * Pure: builds the DynamoDB input and makes the replay decision; route.mjs
 * owns the client.
 */

/** UpdateItem input stamping the first action time on a CARD# item. */
export function markCardActed({ table, householdId, cardId, at }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
    // First action wins — a later stray press never moves the timestamp.
    UpdateExpression: 'SET actedAt = if_not_exists(actedAt, :at)',
    // An id the server never sent (the on-device SP-1 spike card) must not
    // conjure a CARD# item that reconcile would then push to the device.
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':at': { N: String(at) } },
  };
}

/**
 * UpdateItem input counting one showing on a CARD# item.
 *
 * The television says `card_shown` when a card is really on screen
 * (apps/tv-vega BreakController.noteShown). A card that waits for a natural
 * break is shown at two of them and never at a third (NaturalBreakEngine
 * Rule 3) — and the count has to live here, because the television's own
 * is gone every time the app leaves the screen.
 */
export function markCardShown({ table, householdId, cardId }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
    UpdateExpression: 'ADD shown :one',
    // As markCardActed: never conjure a card the server did not send.
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':one': { N: '1' } },
  };
}

/**
 * The card as reconcile sends it back: as it was stored, with the showings
 * counted since. The television decides what that means — after two, the
 * card waits on its home screen to be asked for instead of being shown.
 *
 * A door card keeps the count it was sent with: it leaves by its clock
 * (isReplayable), and someone at the door is shown however often the
 * resident has looked away.
 */
export function replayedCard(item) {
  const queued = JSON.parse(item.data?.S ?? '{}');
  if (queued.urgency === 'DOOR' || !item.shown?.N) return queued;
  return { ...queued, shownCount: Math.max(Number(queued.shownCount ?? 0), Number(item.shown.N)) };
}

/**
 * Inlined from packages/contracts/src/card.ts's DOOR_CARD_TTL_MS (this plain
 * .mjs Lambda can't import TS) — keep them equal.
 */
const DOOR_CARD_TTL_MS = 5 * 60 * 1000;

/**
 * Whether reconcile may push this CARD# item to a reconnecting device.
 *
 * Decided by the card, never by comparing its id to the device's last-seen
 * id. Ids are not time-ordered (`door-…` < `note-…` < `week-…`), so that
 * comparison silently dropped every note and door card sent while the
 * socket was down after the television had seen a week card. The device
 * upserts by id, so replaying a card it already holds is harmless.
 */
export function isReplayable(item, now) {
  if (item.actedAt) return false;
  const queued = JSON.parse(item.data?.S ?? '{}');
  if (queued.urgency === 'DOOR') {
    const expiresAt = queued.expiresAt ?? (queued.queuedAt ?? 0) + DOOR_CARD_TTL_MS;
    if (now >= expiresAt) return false;
  }
  return true;
}

/** More than any television holds; a longer list is not read past this. */
const MAX_HELD = 200;

/**
 * The cards a reconnecting television says it holds (`holding`) that are
 * already finished: answered on another television in the home while this
 * one was off, or behind another app. Reconcile sends a `revoke` for each,
 * so a note that has had its answer does not go on asking in a second room.
 *
 * Only a card the server knows to be finished. One it has no row for is
 * left alone: not finding a card is not the same as knowing it was answered.
 */
export function finishedAmong(items, holding) {
  if (!Array.isArray(holding)) return [];
  const finished = new Set(items.filter((item) => item.actedAt).map((item) => item.sk?.S?.slice('CARD#'.length)));
  return holding.slice(0, MAX_HELD).filter((id) => typeof id === 'string' && finished.has(id));
}

/**
 * The cards just replayed to a television (`replayedIds`, in order) that
 * are no longer hers to answer, by the rows as they are now (`itemsNow`):
 * answered in the meantime on another television of the home, gone
 * altogether — taken back by their sender — or, for a door card, over.
 * Reconcile sends a `revoke` for each, so a card that finished in the
 * instant it was being handed over does not stay on this screen until the
 * television next connects.
 *
 * Unlike `finishedAmong`, a card with no row IS named here: these are cards
 * this very replay read a row for a moment ago, so a row that is gone is a
 * card that was taken back — not one the server never knew.
 */
export function finishedSince(replayedIds, itemsNow, now) {
  const bySk = new Map((itemsNow ?? []).map((item) => [item.sk?.S, item]));
  return [...new Set(replayedIds)].filter((id) => {
    const item = bySk.get(`CARD#${id}`);
    return !item || !isReplayable(item, now);
  });
}

/**
 * Presses that leave the card on screen: the chime's answer patches onto a
 * door card, and so does the family's when they are asked to look; the live
 * view opens over it; "What Sarah sees" opens over
 * the Week card; the sharing card's toggle and Next replace it in place
 * (sharing.mjs). Retiring those would stop reconcile replaying a card the
 * resident is still looking at — and `sharing` retiring the Week card would
 * release nothing, but would hide the week before the resident pressed OK.
 * And "Yes, ask Sarah" and "Just say hello" on the card her hold brought
 * (reach.mjs): who was asked is written onto that same card a moment later.
 */
const KEEPS_CARD = new Set(['hallway_chime', 'ask_family', 'watch_live', 'sharing', 'toggle', 'next', 'stop', 'keep_wick', 'ring_me', 'say_hello']);

/** Whether a card_action finishes its card server-side (stamps actedAt). */
export function retiresCard(action) {
  return !KEEPS_CARD.has(action);
}
