/**
 * Proof that a request comes from the television itself (AGENTS.md INV-1).
 *
 * A television's id is a label, not a secret: it was shown to family
 * members, written in logs, and on every Vega Virtual Device it is the
 * constant `wick-tv`. So an id alone must not be enough to be handed a
 * token for it.
 *
 * A television that can keep something in its own storage keeps a secret
 * and sends it with every refresh. Fire OS and the browser television make
 * it themselves, from their cryptographic generator, and send it when they
 * ask for a code (pair-start.mjs). A Vega television has no such generator,
 * so it says it can keep one (`keeps`) and the server makes it when the code
 * is entered (`newProof`). Either way the server keeps only its SHA-256 on
 * the television's row (`proofHash`), so nobody who reads the table can use
 * what is there. The secret is long and
 * random, so a plain hash is enough: there is nothing to guess.
 *
 * Every device token says how it was earned, in the claim `proof`:
 *
 *   'pairing' — minted by pair-claim.mjs: the six digits on the screen were
 *               entered by the home's organiser.
 *   'secret'  — minted by pair-refresh.mjs for a television that showed its
 *               secret, or showed a proven token while enrolling one.
 *   'none'    — minted by pair-refresh.mjs from the id alone, for a row
 *               that holds no proof (the Vega Virtual Device, FRICTION.md
 *               FL-013), and only in a demo home (`isDemoHome`). The one
 *               kind that proves nothing, so never one for a real home.
 *
 * A token minted before this claim existed says nothing. Then its lifetime
 * tells: only pair-claim.mjs ever minted one longer than an hour.
 *
 * Pure: no AWS. Tested (__tests__/proof.test.ts).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { REFRESH_TOKEN_TTL_SEC } from './pairing-code.mjs';

/**
 * The id every Vega Virtual Device has (apps/tv-vega/src/deviceId.ts): its
 * storage keeps nothing, so it is never given a secret — one it could not
 * keep would lock it out at its next launch — whatever a request says.
 */
export const SIMULATOR_DEVICE_ID = 'wick-tv';

/**
 * A secret the server makes for a television that keeps a file but has no
 * cryptographic generator of its own (Vega: apps/tv-vega/src/random.ts).
 * pair-claim.mjs makes it when the code is entered; pair-status.mjs hands it
 * over once, with the token, to the television polling that code — which
 * already receives the thirty-day token the same way, so this is no weaker.
 */
export function newProof() {
  return randomBytes(32).toString('hex');
}

export const PROVEN_BY_PAIRING = 'pairing';
export const PROVEN_BY_SECRET = 'secret';
export const UNPROVEN = 'none';

/** What a television's secret looks like: long, random, and safe in JSON. Anything else is not one, and is not hashed. */
const PROOF_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;

export function isProof(value) {
  return typeof value === 'string' && PROOF_SHAPE.test(value);
}

/** What the row keeps of a secret: its SHA-256, hex. Never the secret. */
export function proofHashOf(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Whether a secret is the one whose hash the row keeps. Compared in constant time, so the time taken says nothing. */
export function proofMatches(secret, storedHash) {
  if (!isProof(secret) || typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(proofHashOf(secret), 'hex'), Buffer.from(storedHash, 'hex'));
}

/** Whether a verified token was minted without proof. A token from before the claim existed counts as unproven when it lasted an hour or less. */
export function isUnproven(claims) {
  if (claims?.proof === UNPROVEN) return true;
  if (claims?.proof === PROVEN_BY_PAIRING || claims?.proof === PROVEN_BY_SECRET) return false;
  const lifetime = Number(claims?.exp) - Number(claims?.iat);
  return !(Number.isFinite(lifetime) && lifetime > REFRESH_TOKEN_TTL_SEC);
}

/**
 * Whether a television whose row now holds a proof may still be served on
 * a token minted without one. It may not: an unproven token minted before
 * the television enrolled its secret is refused from that moment, by
 * connect.mjs, the IoT authorizer at every re-check, every message on a
 * WebSocket opened with it (route.mjs) and Watch live.
 */
export function refusesUnproven(item, unproven) {
  return unproven === true && typeof item?.proofHash?.S === 'string';
}

/**
 * Whether a household is a demo home: its META row is marked `simulated`
 * (every row of a demo home is). Only there is a television that keeps no
 * secret connected (pair-claim.mjs) or answered from its id alone
 * (pair-refresh.mjs): nobody lives in a demo home, and its rows are made up.
 */
export function isDemoHome(meta) {
  return meta?.simulated?.BOOL === true;
}
