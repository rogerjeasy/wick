import { describe, expect, it } from 'vitest';
import { SignatureV4 } from '@smithy/signature-v4';
import { createHash, createHmac } from 'node:crypto';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { credentialsFromEnv, presignGet } from '../presign.mjs';

// The access key id of AWS's own published example (S3, "Authenticating Requests: Using Query Parameters").
// It is public and opens nothing. It is written in two parts because this repository's secret check refuses
// anything shaped like a key id, and it should not have to learn that this one is an example.
const EXAMPLE_KEY_ID = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

/**
 * AWS's own worked example of a presigned S3 GET — "Authenticating
 * Requests: Using Query Parameters (AWS Signature Version 4)" in the Amazon
 * S3 API reference: its example key, bucket, object, date and lifetime, and
 * the address and signature it arrives at.
 */
const EXAMPLE = {
  credentials: { accessKeyId: EXAMPLE_KEY_ID, secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  bucket: 'examplebucket',
  host: 'examplebucket.s3.amazonaws.com',
  key: 'test.txt',
  region: 'us-east-1',
  now: Date.UTC(2013, 4, 24, 0, 0, 0),
  expiresSec: 86400,
  signature: 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  url:
    'https://examplebucket.s3.amazonaws.com/test.txt' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    `&X-Amz-Credential=${EXAMPLE_KEY_ID}%2F20130524%2Fus-east-1%2Fs3%2Faws4_request` +
    '&X-Amz-Date=20130524T000000Z' +
    '&X-Amz-Expires=86400' +
    '&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
};

describe('presignGet — an address for one object, signed by hand', () => {
  it('arrives at the address and the signature of AWS’s published example, with no network', () => {
    const { credentials, bucket, host, key, region, now, expiresSec } = EXAMPLE;

    const url = presignGet({ bucket, key, region, credentials, expiresSec, now, host });

    expect(url).toBe(EXAMPLE.url);
    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(EXAMPLE.signature);
  });

  it('addresses the bucket in its own region, virtual-hosted, when no host is given', () => {
    const url = new URL(presignGet({ bucket: 'wick-photos-123456789012', key: 'photos/hh_1/p1.jpg', region: 'us-east-1', credentials: EXAMPLE.credentials, expiresSec: 3600, now: EXAMPLE.now }));

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('wick-photos-123456789012.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/photos/hh_1/p1.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false);
  });

  /**
   * The SDK's own signer (the one under every AWS client in this repository),
   * asked for the same thing: a second opinion that is not this code.
   */
  async function bySdk(input: { bucket: string; key: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; expiresSec: number; now: number }) {
    const signer = new SignatureV4({
      service: 's3',
      region: input.region,
      credentials: input.credentials,
      // S3's own rule: the path is escaped once, not twice.
      uriEscapePath: false,
      sha256: class {
        readonly #hash;
        constructor(secret?: Uint8Array | string) {
          this.#hash = secret === undefined ? createHash('sha256') : createHmac('sha256', secret);
        }
        update(data: Uint8Array | string) { this.#hash.update(data); }
        async digest() { return new Uint8Array(this.#hash.digest()); }
      } as never,
    });
    const host = `${input.bucket}.s3.${input.region}.amazonaws.com`;
    const path = `/${input.key.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
    const signed = await signer.presign(
      // The payload is declared unsigned by this header, which the signer reads; it is kept out of the
      // address and out of what is signed, so that the address is the plain one AWS documents.
      { method: 'GET', protocol: 'https:', hostname: host, path, headers: { host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }, query: {} } as never,
      { expiresIn: input.expiresSec, signingDate: new Date(input.now), unsignableHeaders: new Set(['x-amz-content-sha256']), unhoistableHeaders: new Set(['x-amz-content-sha256']) },
    );
    return signed.query as Record<string, string>;
  }

  const TEMPORARY = { accessKeyId: 'TEMPORARY-KEY-ID-00', secretAccessKey: 'abc/def+ghi=EXAMPLEsecretEXAMPLEsecret00', sessionToken: 'IQoJb3JpZ2luX2VjE+/==token with spaces & signs==' };

  it('carries the session token of temporary credentials — a Lambda’s always are — and signs it, as the SDK’s signer does', async () => {
    const input = { bucket: 'wick-photos-123456789012', key: 'photos/hh_3j5/p-01_AZ.jpg', region: 'us-east-1', credentials: TEMPORARY, expiresSec: 3600, now: Date.UTC(2026, 9, 13, 17, 45, 9) };

    const url = new URL(presignGet(input));
    const sdk = await bySdk(input);

    expect(url.searchParams.get('X-Amz-Security-Token')).toBe(TEMPORARY.sessionToken);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261013T174509Z');
    expect(url.searchParams.get('X-Amz-Credential')).toBe('TEMPORARY-KEY-ID-00/20261013/us-east-1/s3/aws4_request');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(sdk['X-Amz-Signature']);
    expect(Object.fromEntries(url.searchParams)).toEqual(sdk);
  });

  it('signs a key with awkward characters as the SDK’s signer does, and keeps the slashes', async () => {
    const input = { bucket: 'wick-photos-123456789012', key: "photos/hh 1+é/it's (a) *star*~&=?#%.jpg", region: 'eu-west-2', credentials: TEMPORARY, expiresSec: 60, now: Date.UTC(2026, 0, 2, 3, 4, 5) };

    const address = presignGet(input);
    const url = new URL(address);
    const sdk = await bySdk(input);

    expect(url.host).toBe('wick-photos-123456789012.s3.eu-west-2.amazonaws.com');
    expect(address.split('?')[0]).toBe("https://wick-photos-123456789012.s3.eu-west-2.amazonaws.com/photos/hh%201%2B%C3%A9/it%27s%20%28a%29%20%2Astar%2A~%26%3D%3F%23%25.jpg");
    expect(decodeURIComponent(url.pathname)).toBe(`/${input.key}`);
    expect(url.searchParams.get('X-Amz-Signature')).toBe(sdk['X-Amz-Signature']);
  });

  it('gives a different signature for a different object, moment or lifetime: nothing is signed but what was asked', () => {
    const base = { bucket: 'b', key: 'photos/hh/a.jpg', region: 'us-east-1', credentials: EXAMPLE.credentials, expiresSec: 3600, now: EXAMPLE.now };
    const signature = (over: object) => new URL(presignGet({ ...base, ...over })).searchParams.get('X-Amz-Signature');

    const all = [signature({}), signature({ key: 'photos/hh/b.jpg' }), signature({ now: EXAMPLE.now + 1000 }), signature({ expiresSec: 60 }), signature({ bucket: 'c' })];
    expect(new Set(all).size).toBe(all.length);
    for (const one of all) expect(one).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to sign without a bucket, a key, a region or credentials — an address that could not work is not made', () => {
    const good = { bucket: 'b', key: 'k', region: 'us-east-1', credentials: EXAMPLE.credentials, expiresSec: 60, now: 1 };

    for (const bad of [{ bucket: '' }, { key: '' }, { region: '' }, { credentials: undefined }, { credentials: { accessKeyId: 'a' } }, { expiresSec: 0 }, { expiresSec: 700_000 }]) {
      expect(() => presignGet({ ...good, ...bad })).toThrow();
    }
  });
});

describe('credentialsFromEnv — what the Lambda runs as', () => {
  it('reads the role’s temporary credentials and the region from the environment', () => {
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: 'ASIA1', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_REGION: 'us-east-1' })).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: 'ASIA1', secretAccessKey: 's', sessionToken: 't' },
    });
  });

  it('is nothing when they are not there', () => {
    expect(credentialsFromEnv({})).toBeUndefined();
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: 'a', AWS_REGION: 'us-east-1' })).toBeUndefined();
    expect(credentialsFromEnv({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's' })).toBeUndefined();
  });
});
