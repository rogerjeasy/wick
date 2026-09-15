/**
 * Token lifetime policy — pure, no AWS, no network. Tested.
 *
 * Ring issues access tokens that live ~4 hours and refresh tokens that live
 * ~30 days. Two consequences shape everything here:
 *
 *   1. An access token WILL expire mid-demo. Refresh has to be automatic, not
 *      a thing anyone remembers to do.
 *   2. The refresh token is the whole link. If a refresh response omits one —
 *      Ring is not documented either way — keeping the previous one is the
 *      difference between "refreshed" and "silently unlinked until someone
 *      signs in again". `mergeTokens` never lets a refresh token go missing.
 */

/** Refresh this long before expiry rather than at it. */
export const REFRESH_SKEW_MS = 10 * 60 * 1000;

/** Fallback when Ring omits expires_in. Ring's documented value is 14400s. */
export const DEFAULT_EXPIRES_IN_S = 4 * 60 * 60;

/**
 * Absolute expiry, in epoch ms, for a stored token record.
 * Prefers the stamped `expiresAt`; falls back to obtainedAt + expires_in.
 */
export function expiresAt(record) {
  if (!record) return 0;
  if (Number.isFinite(record.expiresAt)) return record.expiresAt;

  const obtained = Number.isFinite(record.obtainedAt) ? record.obtainedAt : 0;
  const lifetime = Number.isFinite(record.expires_in)
    ? record.expires_in
    : DEFAULT_EXPIRES_IN_S;

  return obtained + lifetime * 1000;
}

/**
 * Should we refresh before using this record?
 *
 * A record with no access token, or no expiry we can compute, refreshes. Erring
 * towards one unnecessary refresh beats erring towards a 401 on the door event
 * that the whole demo turns on.
 */
export function needsRefresh(record, now = Date.now()) {
  if (!record?.access_token) return true;
  return expiresAt(record) - REFRESH_SKEW_MS <= now;
}

/** Can this record still be refreshed at all, or is a fresh sign-in required? */
export function isRefreshable(record) {
  return Boolean(record?.refresh_token);
}

/**
 * Fold a token response into the stored record.
 *
 * Carries forward anything Ring did not resend — refresh_token above all, plus
 * the account identifier we paid a round trip for — and stamps an absolute
 * expiry so no later reader has to redo this arithmetic.
 */
export function mergeTokens(previous, fresh, now = Date.now()) {
  const merged = { ...(previous ?? {}), ...(fresh ?? {}) };

  if (!fresh?.refresh_token && previous?.refresh_token) {
    merged.refresh_token = previous.refresh_token;
  }

  const lifetime = Number.isFinite(merged.expires_in)
    ? merged.expires_in
    : DEFAULT_EXPIRES_IN_S;

  merged.obtainedAt = now;
  merged.expiresAt = now + lifetime * 1000;

  return merged;
}
