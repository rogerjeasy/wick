/** Pure pairing-nonce logic — code generation and TTL math. No AWS. Tested. */
import { randomInt } from 'node:crypto';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

// Shorter than DEVICE_TOKEN_TTL_SEC on purpose: pair-refresh.mjs mints from
// nothing but {deviceId, householdId}, with no proof of possession (see its
// header comment for why). A short TTL bounds how long a token minted that
// way stays valid if it's ever minted by someone who only has those public
// identifiers, not physical access to the paired device.
export const REFRESH_TOKEN_TTL_SEC = 60 * 60;

// Throttle on pair-refresh.mjs: legitimate callers (App.tsx, CardService.ts)
// each refresh once per launch, not in a loop. This is not a defense against
// a determined attacker — one call is enough to mint a token — but it blunts
// automated/repeated abuse and gives an operator a signal to notice.
export const REFRESH_MIN_INTERVAL_MS = 30 * 1000;

export function generatePairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isExpired(record, now = Date.now()) {
  return !record || record.expiresAt <= now;
}
