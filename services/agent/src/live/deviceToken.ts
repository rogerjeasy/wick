/**
 * Verifying the device-bound JWT (RS256) that pair-claim.mjs / pair-refresh.mjs
 * mint and edge-device/lambda/jwt.mjs verifies on WebSocket connect. Same
 * wire format; the test signs with jwt.mjs itself so the two cannot drift.
 *
 * The header's alg is checked, not trusted: only RS256 is ever accepted.
 */
import { createVerify } from 'node:crypto';

export interface DeviceClaims {
  readonly deviceId: string;
  readonly householdId: string;
}

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

export function verifyDeviceToken(token: string, publicKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): DeviceClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [header, payload, signature] = parts as [string, string, string];

  if (decode(header).alg !== 'RS256') throw new Error('bad_alg');
  const ok = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKeyPem, Buffer.from(signature, 'base64url'));
  if (!ok) throw new Error('bad_signature');

  const claims = decode(payload);
  if (typeof claims.exp === 'number' && claims.exp < nowSec) throw new Error('expired');
  if (typeof claims.deviceId !== 'string' || typeof claims.householdId !== 'string') throw new Error('bad_claims');
  return { deviceId: claims.deviceId, householdId: claims.householdId };
}
