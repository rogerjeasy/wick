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

/** Whether reconcile may push this CARD# item to a reconnecting device. */
export function isReplayable(item, sinceCardId) {
  if (item.actedAt) return false;
  if (sinceCardId && item.sk.S === `CARD#${sinceCardId}`) return false; // exact match: client already has this one
  return true;
}

/**
 * Door presses that leave the card on screen: the chime's answer patches onto
 * it, and the live view opens over it. Retiring those would stop reconcile
 * replaying a card the resident is still looking at.
 */
const KEEPS_CARD = new Set(['hallway_chime', 'watch_live']);

/** Whether a card_action finishes its card server-side (stamps actedAt). */
export function retiresCard(action) {
  return !KEEPS_CARD.has(action);
}
