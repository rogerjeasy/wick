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
  /**
   * Minted from the television's id alone (edge-device proof.mjs): said only
   * when true. Such a token is refused once the television's row keeps a
   * proof (`refusesUnproven`).
   */
  readonly unproven?: true;
}

/** The longest a token minted by a refresh lives (edge-device pairing-code.mjs REFRESH_TOKEN_TTL_SEC). */
const REFRESH_TOKEN_TTL_SEC = 60 * 60;

/**
 * Whether a token was minted without proof — the same rule as edge-device
 * proof.mjs `isUnproven`, which is the one tested against the Lambdas that
 * mint them: it says so (`proof: 'none'`), or it says nothing and lived an
 * hour or less, as only a refresh ever minted.
 */
function isUnproven(claims: Record<string, unknown>): boolean {
  if (claims.proof === 'none') return true;
  if (claims.proof === 'pairing' || claims.proof === 'secret') return false;
  const lifetime = Number(claims.exp) - Number(claims.iat);
  return !(Number.isFinite(lifetime) && lifetime > REFRESH_TOKEN_TTL_SEC);
}

/** Whether a television's DEV# row refuses this token: it keeps a proof, and the token was minted without one. */
export function refusesUnproven(item: { readonly proofHash?: { readonly S?: string } } | undefined, claims: DeviceClaims): boolean {
  return claims.unproven === true && typeof item?.proofHash?.S === 'string';
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
  return { deviceId: claims.deviceId, householdId: claims.householdId, ...(isUnproven(claims) ? { unproven: true as const } : {}) };
}
