/**
 * Sarah's television — a television in a family member's own home.
 *
 * The same app, connected by a member as *theirs*. It is not the resident's
 * television in any sense that matters, and it is kept apart from one where
 * everything that matters is decided:
 *
 *   - Its row is `HH#<household>` / `FTV#<deviceId>`, never `DEV#…`. Every
 *     card for the resident, every press that counts as hers — allowing
 *     someone into the circle, telling the family, confirming a visit — and
 *     the light in her window are keyed on `DEV#` rows
 *     (device-standing.mjs, the agent plane's egress.ts). A family
 *     television has none, so all of that refuses it without having to
 *     know it exists.
 *   - Its token says so: `kind: 'family'` and the `userId` of the member
 *     who connected it. What it may do with that token is the Wick server's
 *     to say (mcp-server familyTelevision.ts): a fixed list of what that
 *     one member may already read and answer, checked against the circle on
 *     every call (INV-9).
 *
 * The Wick server checks that token's signature with the pairing key's
 * public half, which it has no other way to hold; pair-claim.mjs publishes
 * it in the table when a family television is connected. A public key is
 * not a secret.
 *
 * Pure: the handlers own the DynamoDB client.
 */

export const FAMILY_KIND = 'family';
export const FAMILY_TV_SK_PREFIX = 'FTV#';

export function familyTelevisionKey(householdId, deviceId) {
  return { pk: { S: `HH#${householdId}` }, sk: { S: `${FAMILY_TV_SK_PREFIX}${deviceId}` } };
}

/** Where the Wick server reads the key it checks a family television's token with. */
export const PAIRING_PUBLIC_KEY = { pk: { S: 'CONFIG#pairing' }, sk: { S: 'PUBLIC_KEY' } };

export function publicKeyItem(publicKeyPem) {
  return { ...PAIRING_PUBLIC_KEY, publicKeyPem: { S: publicKeyPem } };
}

/** What a television is being connected as: undefined for the resident's own, 'family', or null for anything else. */
export function kindAskedFor(as) {
  if (as === undefined || as === null || as === '') return undefined;
  return as === FAMILY_KIND ? FAMILY_KIND : null;
}

/**
 * The one narrower thing a family television's token can be for: asking the
 * Wick server what waits for its member, in a sentence each, while the app
 * is off the screen (`GET /tv/waiting`; contracts FAMILY_TV_WAITING_SCOPE).
 * Held only by the television's background service (pair-refresh.mjs).
 */
export const WAITING_SCOPE = 'waiting';

/**
 * How long the way the app opens for its background service stays open.
 * Longer than the half minute a service told "too soon" waits before asking
 * again (pairing-code.mjs REFRESH_WINDOW_MS, and the television's own 32 s),
 * and no longer than it needs to be.
 */
export const SERVICE_WINDOW_MS = 90 * 1000;

/**
 * The longest a background service's session lasts: from the moment the
 * service is let in, however often its narrow token is renewed. After it,
 * the token is not renewed again, and the service is let in afresh the next
 * time the app is on screen. A stolen narrow token is good for this long at
 * most — and for less, since the next hand-off ends it at once.
 */
export const SERVICE_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The claims a family television's token carries beside its device and
 * household. `scope` only ever narrows it; a narrow token also says `since`
 * — when its service's session began, in ms — which is what the row's
 * `serviceSince` is compared with, here and by the Wick server.
 */
export function familyClaims(userId, scope, since) {
  return { kind: FAMILY_KIND, userId, ...(scope ? { scope, since } : {}) };
}

/** The member a family television belongs to, from its row — or undefined for a row that is not one, or a television revoked. */
export function memberOfFamilyTelevision(item) {
  if (!item || item.denylisted?.BOOL === true) return undefined;
  return item.userId?.S || undefined;
}
