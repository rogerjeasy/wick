/** Pure pairing-nonce logic — code generation and TTL math. No AWS. Tested. */
import { randomInt } from 'node:crypto';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export function generatePairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isExpired(record, now = Date.now()) {
  return !record || record.expiresAt <= now;
}
