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

export function verifyJwt(token, publicKeyPem) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [headerB64, payloadB64, sigB64] = parts;

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64, 'base64url');
  const ok = createVerify('RSA-SHA256').update(signingInput).verify(publicKeyPem, signature);
  if (!ok) throw new Error('bad_signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw new Error('expired');
  return payload;
}
