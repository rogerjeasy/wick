import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  signJwt,
  verifyJwt,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../jwt.mjs';

function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
}

describe('signJwt / verifyJwt', () => {
  it('round-trips claims through sign and verify', () => {
    const { privateKeyPem, publicKeyPem } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: 60 });

    const claims = verifyJwt(token, publicKeyPem);

    expect(claims.deviceId).toBe('d1');
    expect(claims.householdId).toBe('h1');
  });

  it('rejects an expired token', () => {
    const { privateKeyPem, publicKeyPem } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: -1 });

    expect(() => verifyJwt(token, publicKeyPem)).toThrow('expired');
  });

  it('rejects a token signed with a different key', () => {
    const { privateKeyPem } = testKeyPair();
    const { publicKeyPem: otherPublicKey } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: 60 });

    expect(() => verifyJwt(token, otherPublicKey)).toThrow('bad_signature');
  });

  it('rejects a malformed token', () => {
    const { publicKeyPem } = testKeyPair();
    expect(() => verifyJwt('not-a-jwt', publicKeyPem)).toThrow('malformed_token');
  });
});
