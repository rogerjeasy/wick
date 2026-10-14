/** Pure pairing-nonce logic — code generation and TTL math. No AWS. Tested. */
import { randomInt } from 'node:crypto';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

// Shorter than DEVICE_TOKEN_TTL_SEC on purpose: for a television whose row
// keeps no proof (the Vega Virtual Device, proof.mjs), pair-refresh.mjs mints
// from nothing but its id (see its header comment for why). A short TTL bounds
// how long a token minted that way stays valid if it's ever minted by someone
// who only knows that id, not the television itself. proof.mjs also reads it:
// a token from before tokens said how they were earned, and no longer than
// this, counts as unproven.
export const REFRESH_TOKEN_TTL_SEC = 60 * 60;

// Throttle on pair-refresh.mjs. One launch of Wick is two refreshes where
// the television's disk keeps nothing (FRICTION.md FL-013): the app, then
// the card service it starts a second later. So the allowance is two
// launches' worth in half a minute — one a launch refused the card service
// every time, and a refusal reads as "not paired". This is not a defense
// against a determined attacker — one call is enough to mint a token — but
// it blunts automated/repeated abuse and gives an operator a signal to
// notice.
export const REFRESH_WINDOW_MS = 30 * 1000;
export const REFRESH_MAX_PER_WINDOW = 4;

/**
 * One more refresh for the television this binding row is for: the window
 * and count the row should hold afterwards, or null when it has had its
 * share. The window runs from its first refresh, so a television that keeps
 * asking does not keep pushing its own limit out of reach.
 */
export function nextRefreshWindow(item, now) {
  const at = Number(item?.refreshWindowAt?.N ?? 0);
  const count = Number(item?.refreshCount?.N ?? 0);
  if (!at || now - at >= REFRESH_WINDOW_MS) return { at: now, count: 1 };
  if (count >= REFRESH_MAX_PER_WINDOW) return null;
  return { at, count: count + 1 };
}

export function generatePairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isExpired(record, now = Date.now()) {
  return !record || record.expiresAt <= now;
}

/**
 * The link shown beside the six-digit code. It opens the family app
 * (apps/sim-alexa) with the code filled in: connecting a television needs
 * the organiser signed in, so there is no longer a page that can do it on
 * its own.
 */
export function pairingUrl(base, code) {
  return `${String(base).replace(/\/+$/, '')}/?pair=${code}`;
}
