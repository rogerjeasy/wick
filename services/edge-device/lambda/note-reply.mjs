/**
 * M3, the way back: the resident answers a family note with one button,
 * and the answer is kept on the note's own CARD# item for the family to
 * read (services/mcp-server/src/tools/get_replies.ts).
 *
 * The television sends only which button was pressed (`reply_<n>`). The
 * words come from the server's own stored copy of the card, so a device
 * can only ever send one of the replies Wick offered. It can never put
 * arbitrary text in front of the family.
 *
 * Pure: route.mjs owns the DynamoDB client.
 */

const NOTE_CARD_ID = /^note-/;
const REPLY_ACTION = /^reply_([0-2])$/;

/** The reply's position, when this action is a reply to a note card. */
export function replyIndex(cardId, action) {
  if (!NOTE_CARD_ID.test(cardId) || typeof action !== 'string') return undefined;
  const match = REPLY_ACTION.exec(action);
  return match ? Number(match[1]) : undefined;
}

/** The label Wick offered at that position, read from the stored CARD# item. */
export function replyText(item, index) {
  const raw = item?.data?.S;
  if (!raw) return undefined;
  const card = JSON.parse(raw).card;
  if (card?.type !== 'MESSAGE' || !Array.isArray(card.suggestedReplies)) return undefined;
  const text = card.suggestedReplies[index];
  return typeof text === 'string' ? text : undefined;
}

/** UpdateItem input recording the reply. The first reply is the reply. */
export function markNoteReplied({ table, householdId, cardId, text, at }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
    UpdateExpression: 'SET replyText = if_not_exists(replyText, :text), repliedAt = if_not_exists(repliedAt, :at)',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':text': { S: text }, ':at': { N: String(at) } },
  };
}

/**
 * Back on a note: "later" (packages/contracts card.ts NOTE_ACTIONS). Not a
 * reply — nothing is said to the family for her — and not an answer, so the
 * note is not finished (card-acted.mjs KEEPS_CARD): it waits on her home
 * screen's quiet line until she opens it and answers.
 */
const LATER_ACTION = 'later';

export function putsNoteAway(cardId, action) {
  return NOTE_CARD_ID.test(cardId) && action === LATER_ACTION;
}

/**
 * Inlined from packages/contracts/src/card.ts's MAX_CARD_SHOWS (this plain
 * .mjs Lambda can't import TS) — keep them equal.
 */
const MAX_CARD_SHOWS = 2;

/**
 * UpdateItem input for a note she put away. `seenAt` is the first time she
 * did: the family is told that she has seen the note, never when
 * (get_replies.ts). Its showings are made two, so reconcile hands it to any
 * television of the home as one that waits to be asked for (card-acted.mjs
 * replayedCard), and none brings it to her again by itself.
 */
export function markNoteSeen({ table, householdId, cardId, at }) {
  return {
    TableName: table,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `CARD#${cardId}` } },
    UpdateExpression: 'SET seenAt = if_not_exists(seenAt, :at), shown = :showings',
    ConditionExpression: 'attribute_exists(pk)',
    ExpressionAttributeValues: { ':at': { N: String(at) }, ':showings': { N: String(MAX_CARD_SHOWS) } },
  };
}
