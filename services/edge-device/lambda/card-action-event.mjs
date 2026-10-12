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
