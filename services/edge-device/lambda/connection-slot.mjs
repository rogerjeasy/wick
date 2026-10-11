/**
 * Which of a television's two connections this is. Pure — no AWS. Tested.
 *
 * A television holds up to two WebSocket connections at once:
 *   - foreground: the Wick app itself, on screen. It renders cards.
 *   - background: the app's card service, which keeps running while another
 *     app is in front. It cannot render a card — it can only put a system
 *     toast on screen saying one is waiting.
 * Each has its own attributes on the DEV# item, so one connecting or
 * dropping never disturbs the other (last connect wins *within* a slot,
 * as before). Senders prefer foreground and fall back to background
 * (services/agent/src/egress.ts).
 *
 * Anything but an exact `role=background` is foreground: every television
 * paired before this existed sends no role at all.
 */
export const FOREGROUND_SLOT = {
  role: 'foreground',
  connectionId: 'connectionId',
  attributes: ['connectionId', 'transport', 'wsEndpoint', 'connectedAt'],
};

export const BACKGROUND_SLOT = {
  role: 'background',
  connectionId: 'bgConnectionId',
  attributes: ['bgConnectionId', 'bgTransport', 'bgWsEndpoint', 'bgConnectedAt'],
};

export function slotForRole(role) {
  return role === BACKGROUND_SLOT.role ? BACKGROUND_SLOT : FOREGROUND_SLOT;
}

/** `SET <connectionId> = :c, <transport> = :t, <wsEndpoint> = :w, <connectedAt> = :ca` for this slot. */
export function setExpression(slot) {
  const [connectionId, transport, wsEndpoint, connectedAt] = slot.attributes;
  return `SET ${connectionId} = :c, ${transport} = :t, ${wsEndpoint} = :w, ${connectedAt} = :ca`;
}

/** `REMOVE …` for this slot's attributes, and the guard that it is still this connection's. */
export function clearExpressions(slot) {
  return {
    UpdateExpression: `REMOVE ${slot.attributes.join(', ')}`,
    ConditionExpression: `${slot.connectionId} = :cid`,
  };
}
