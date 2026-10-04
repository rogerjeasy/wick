/**
 * Secrets Wick hands out — access tokens, refresh tokens, authorization
 * codes, the sign-in cookie — are random, and only their SHA-256 is ever
 * stored. Someone who can read the table cannot use what they find there.
 *
 * `hashToken` is a wire contract with services/edge-device/lambda/
 * wick-auth.mjs, which hashes a bearer token the same way to find its grant
 * (packages/contracts/src/circle.ts ACCESS_TOKEN_KEY_PREFIX).
 */
import { createHash, randomBytes } from 'node:crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Short enough to sit in a link, long enough not to be guessed: 120 bits. */
export function randomId(): string {
  return randomBytes(15).toString('base64url');
}
