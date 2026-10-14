import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt } from '../../../../edge-device/lambda/jwt.mjs';
import { refusesUnproven, verifyDeviceToken } from '../deviceToken.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('verifyDeviceToken — the same device JWT pair-claim.mjs mints', () => {
  it('returns the device and household of a valid token', () => {
    const token = signJwt({ deviceId: 'wick-tv', householdId: 'margaret', proof: 'pairing' }, priv, { expiresInSec: 60 });
    expect(verifyDeviceToken(token, pub)).toEqual({ deviceId: 'wick-tv', householdId: 'margaret' });
  });

  // INV-1: a token minted from the id alone (edge-device proof.mjs) says so,
  // and is no good for a television whose row has since taken a proof.
  it('says when a token was minted without proof — by its claim, or, from before the claim, by an hour’s lifetime', () => {
    const minted = (claims: object, expiresInSec: number) => verifyDeviceToken(signJwt({ deviceId: 'tv', householdId: 'h', ...claims }, priv, { expiresInSec }), pub);
    expect(minted({ proof: 'none' }, 3600).unproven).toBe(true);
    expect(minted({ proof: 'secret' }, 3600).unproven).toBeUndefined();
    expect(minted({ proof: 'pairing' }, 30 * 86400).unproven).toBeUndefined();
    expect(minted({}, 3600).unproven).toBe(true);
    expect(minted({}, 30 * 86400).unproven).toBeUndefined();
  });

  it('refuses an unproven token only where the television’s row keeps a proof', () => {
    const unproven = { deviceId: 'tv', householdId: 'h', unproven: true as const };
    const proven = { deviceId: 'tv', householdId: 'h' };
    expect(refusesUnproven({ proofHash: { S: 'a'.repeat(64) } }, unproven)).toBe(true);
    expect(refusesUnproven({}, unproven)).toBe(false);
    expect(refusesUnproven({ proofHash: { S: 'a'.repeat(64) } }, proven)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = signJwt({ deviceId: 'wick-tv', householdId: 'margaret' }, priv, { expiresInSec: -10 });
    expect(() => verifyDeviceToken(token, pub)).toThrow('expired');
  });

  it('rejects a token signed by any other key', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = signJwt({ deviceId: 'wick-tv', householdId: 'margaret' }, other, { expiresInSec: 60 });
    expect(() => verifyDeviceToken(token, pub)).toThrow('bad_signature');
  });

  it('rejects a token whose header asks for anything but RS256', () => {
    const [, payload, sig] = signJwt({ deviceId: 'd', householdId: 'h' }, priv, { expiresInSec: 60 }).split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(() => verifyDeviceToken(`${none}.${payload}.${sig}`, pub)).toThrow();
  });

  it('rejects a token without device and household claims', () => {
    const token = signJwt({ sub: 'x' }, priv, { expiresInSec: 60 });
    expect(() => verifyDeviceToken(token, pub)).toThrow('bad_claims');
  });
});
