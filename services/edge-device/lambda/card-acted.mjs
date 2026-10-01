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

/**
 * Presses that leave the card on screen: the chime's answer patches onto a
 * door card, and the live view opens over it; "What Sarah sees" opens over
 * the Week card; the sharing card's toggle and Next replace it in place
 * (sharing.mjs). Retiring those would stop reconcile replaying a card the
 * resident is still looking at — and `sharing` retiring the Week card would
 * release nothing, but would hide the week before the resident pressed OK.
 */
const KEEPS_CARD = new Set(['hallway_chime', 'watch_live', 'sharing', 'toggle', 'next']);

/** Whether a card_action finishes its card server-side (stamps actedAt). */
export function retiresCard(action) {
  return !KEEPS_CARD.has(action);
}
