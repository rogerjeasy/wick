/**
 * Which device card actions the agent plane must carry out, and the event
 * that tells it to. Pure; route.mjs owns the EventBridge client.
 *
 * Only ids travel — the card itself stays in DynamoDB, where the consumer
 * re-reads it (and so can tell a live card from one that aged out).
 *
 * Watch live is not here: the device asks for a live session itself, over
 * HTTPS with its device token (live-start.mjs), because it needs the answer
 * — a playlist URL — and a bus can't give one back.
 */
// The chime, "Ask Sarah to look" (services/agent door/askFamily.ts), and the
// resident's answer to "Shall I tell Sarah?" (agents/tell/answer.ts).
import { retiresCard } from './card-acted.mjs';

const SERVER_ACTIONS = new Set(['hallway_chime', 'ask_family', 'tell_family', 'keep_private']);

export function shouldPublish(action) {
  return SERVER_ACTIONS.has(action);
}

export function buildCardActionEntry({ busName, householdId, deviceId, cardId, action, at }) {
  return {
    EventBusName: busName,
    Source: 'wick.device',
    DetailType: 'card.action',
    Detail: JSON.stringify({ householdId, deviceId, cardId, action, at }),
  };
}

/**
 * Whether a press has to be announced as having finished its card.
 *
 * The television that was pressed puts the card away itself. Another one in
 * the same home — a second room — still has it: a note already answered,
 * still asking. So the agent plane is told, and takes it off the others
 * (services/agent egress.ts withdrawFromDevices; the edge may only answer
 * the television that spoke, INV-2).
 *
 * Not for a press the agent plane already carries out: it hears of that one
 * as `card.action`, and withdraws the card itself once the answer is kept.
 */
export function announcesRetirement(action) {
  return retiresCard(action) && !shouldPublish(action);
}

export function buildCardRetiredEntry({ busName, householdId, deviceId, cardId, at }) {
  return {
    EventBusName: busName,
    Source: 'wick.device',
    DetailType: 'card.retired',
    Detail: JSON.stringify({ householdId, deviceId, cardId, at }),
  };
}
