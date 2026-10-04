/**
 * INV-9: the resident's answer. A press on a Circle card is the only thing
 * that turns a pending membership into an allowed one.
 *
 * The television sends only which card and which button. Who the card is
 * about comes from its id (`circle-<userId>`), exactly as the Week card's id
 * names its week — so a television holds nothing about the person, and can
 * say nothing about anyone it was not sent a card for... except by naming
 * another id, which is why the update below is conditional: only a
 * membership still waiting for an answer can be answered. A television
 * cannot re-allow someone the organiser removed, or undo a decision.
 *
 * This plain .mjs Lambda can't import TS; the constants are inlined from
 * packages/contracts/src/circle.ts (CIRCLE_ACTIONS, circleCardId) — keep
 * them in step (circle.test.ts holds them to it).
 *
 * Pure: route.mjs owns the DynamoDB client.
 */

const CIRCLE_CARD_ID = /^circle-(.+)$/;
const STATUS_FOR_ACTION = { allow: 'allowed', decline: 'declined' };

/** Who a press on a Circle card is about, and what the resident said. */
export function circleDecision(cardId, action) {
  const match = typeof cardId === 'string' ? CIRCLE_CARD_ID.exec(cardId) : null;
  const status = Object.hasOwn(STATUS_FOR_ACTION, action) ? STATUS_FOR_ACTION[action] : undefined;
  if (!match || !status) return undefined;
  return { userId: match[1], status };
}

/** UpdateItem input recording the resident's answer on the membership. */
export function membershipDecisionUpdate({ table, householdId, userId, status, at }) {
  if (status !== 'allowed' && status !== 'declined') throw new Error(`${status} is not the resident's to give`);
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `MEM#${userId}` } },
    UpdateExpression: 'SET #status = :status, decidedAt = :at',
    ConditionExpression: '#status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': { S: status }, ':pending': { S: 'pending' }, ':at': { N: String(at) } },
  };
}
