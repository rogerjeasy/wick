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

describe('verifyJwt — what it will not take', () => {
  const { privateKeyPem, publicKeyPem } = testKeyPair();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('refuses a token that names any way of signing but the one Wick uses', async () => {
    const { createHmac, createSign } = await import('node:crypto');
    const payload = b64({ deviceId: 'tv-1', householdId: 'hh_1', exp: Math.floor(Date.now() / 1000) + 600 });

    // Unsigned, and saying so.
    expect(() => verifyJwt(`${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`, publicKeyPem)).toThrow();

    // Signed with the public key as if it were a shared secret.
    const hsInput = `${b64({ alg: 'HS256', typ: 'JWT' })}.${payload}`;
    const hsSig = createHmac('sha256', publicKeyPem).update(hsInput).digest('base64url');
    expect(() => verifyJwt(`${hsInput}.${hsSig}`, publicKeyPem)).toThrow('unsupported_alg');

    // A genuine RSA signature under a header that claims something else.
    const lying = `${b64({ alg: 'HS256', typ: 'JWT' })}.${payload}`;
    const rsSig = createSign('RSA-SHA256').update(lying).sign(privateKeyPem).toString('base64url');
    expect(() => verifyJwt(`${lying}.${rsSig}`, publicKeyPem)).toThrow('unsupported_alg');
  });

  it('can be asked to look past the expiry — for telling that a television once held a token — and never past the signature', () => {
    const expired = signJwt({ deviceId: 'tv-1', householdId: 'hh_1' }, privateKeyPem, { expiresInSec: -60 });
    expect(() => verifyJwt(expired, publicKeyPem)).toThrow('expired');
    expect(verifyJwt(expired, publicKeyPem, { ignoreExpiry: true })).toMatchObject({ deviceId: 'tv-1' });

    const other = testKeyPair();
    expect(() => verifyJwt(expired, other.publicKeyPem, { ignoreExpiry: true })).toThrow('bad_signature');
  });
});

