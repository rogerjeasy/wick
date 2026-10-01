import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt } from '../../../../edge-device/lambda/jwt.mjs';
import { verifyDeviceToken } from '../deviceToken.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('verifyDeviceToken — the same device JWT pair-claim.mjs mints', () => {
  it('returns the device and household of a valid token', () => {
    const token = signJwt({ deviceId: 'wick-tv', householdId: 'margaret' }, priv, { expiresInSec: 60 });
    expect(verifyDeviceToken(token, pub)).toEqual({ deviceId: 'wick-tv', householdId: 'margaret' });
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
