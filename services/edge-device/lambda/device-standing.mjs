/**
 * Whether a television is still one this household's cards may go to.
 * Pure — no AWS. Tested.
 *
 * Revoking a television sets `denylisted` on its `HH#<household>` /
 * `DEV#<deviceId>` item. That has to be honoured everywhere the
 * television is served, not only where it comes in:
 *
 *   - connect.mjs refuses it a new connection;
 *   - route.mjs refuses every message on a connection it already holds —
 *     a replay of the household's cards, and every button press, among
 *     them the ones that let a person into the family circle or change
 *     what the family can see;
 *   - the agent plane's egress.ts sends it nothing (the same rule, in
 *     TypeScript: liveDeviceConnections).
 *
 * A television that is no longer paired at all — no item — is refused the
 * same way.
 */
export function deviceBindingKey(householdId, deviceId) {
  return { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } };
}

export function isServed(item) {
  return Boolean(item) && item.denylisted?.BOOL !== true;
}
