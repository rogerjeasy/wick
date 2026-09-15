/**
 * Scheduled token keep-alive.
 *
 * Lazy refresh alone would be enough if traffic were steady. It is not: a
 * household can go quiet for a day, and the first thing to wake the system up
 * is a doorbell press with a five-second budget — the worst possible moment to
 * discover the access token died and spend a round trip to Ring on it.
 *
 * So a schedule keeps the token warm, and `getAccessToken()` stays lazy as the
 * backstop. Neither depends on the other being right.
 */
import { getAccessToken, readTokens } from './ring-token.mjs';
import { expiresAt, isRefreshable } from './token-policy.mjs';

export const handler = async () => {
  const before = await readTokens();

  if (!before) {
    console.log(JSON.stringify({ level: 'info', msg: 'refresh_skipped', reason: 'not_linked' }));
    return { ok: false, reason: 'not_linked' };
  }

  if (!isRefreshable(before)) {
    // Nothing to do but say so loudly: this needs a human to sign in again.
    console.error(JSON.stringify({ level: 'error', msg: 'refresh_impossible', reason: 'no_refresh_token' }));
    return { ok: false, reason: 'no_refresh_token' };
  }

  try {
    await getAccessToken();
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'refresh_failed', reason: err?.message ?? 'unknown',
    }));
    return { ok: false, reason: err?.message ?? 'unknown' };
  }

  const after = await readTokens();
  console.log(JSON.stringify({
    level: 'info',
    msg: 'refresh_ok',
    // Minutes of headroom is the number worth alarming on later.
    minutesToExpiry: Math.round((expiresAt(after) - Date.now()) / 60000),
  }));

  return { ok: true };
};
