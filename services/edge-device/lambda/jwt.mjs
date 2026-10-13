/**
 * Minimal RS256 JWT sign/verify — hand-rolled rather than a dependency, to
 * match services/edge-ring's node:crypto-only style. Only what §4.2 needs:
 * mint a device-bound token (pair-claim.mjs), verify it on WS connect
 * (connect.mjs, Task 7).
 */
import { createSign, createVerify } from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

export function signJwt(claims, privateKeyPem, { expiresInSec }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + expiresInSec };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

/**
 * `ignoreExpiry` is for one question only: did this television once hold a
 * token of Wick's? (pair-refresh.mjs, for a family member's own
 * television.) The signature is checked exactly as always.
 */
export function verifyJwt(token, publicKeyPem, { ignoreExpiry = false } = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [headerB64, payloadB64, sigB64] = parts;

  // One way of signing, and it is said before anything is checked: a token
  // that names another (`none`, or a shared secret made of the public key)
  // is not weighed at all.
  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed_token');
  }
  if (header?.alg !== 'RS256') throw new Error('unsupported_alg');

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64, 'base64url');
  const ok = createVerify('RSA-SHA256').update(signingInput).verify(publicKeyPem, signature);
  if (!ok) throw new Error('bad_signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!ignoreExpiry && typeof payload.exp === 'number' && payload.exp < now) throw new Error('expired');
  return payload;
}
