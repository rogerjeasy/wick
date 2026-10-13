/**
 * An address for one object in S3, good for a short while — signed by hand.
 *
 * The mantelpiece (packages/contracts/src/mantel.ts): a picture's address is
 * minted for her television when it asks, lives an hour at most, and is
 * written nowhere. The edge mints it here, for the cards it sends again and
 * for the mantelpiece she opens (mantel.mjs).
 *
 * By hand, because these Lambdas are deployed as the files they are, with
 * only what the runtime brings: the SDK's S3 presigner is a separate package
 * the runtime is not promised to have, and what it does for a plain GET is
 * small enough to write out. This is AWS Signature Version 4 with the
 * signature in the query string ("Authenticating Requests: Using Query
 * Parameters" in the Amazon S3 API reference), for a GET of one object:
 *
 *   - virtual-hosted style (`<bucket>.s3.<region>.amazonaws.com/<key>`);
 *   - one signed header, `host`;
 *   - the payload unsigned (`UNSIGNED-PAYLOAD`), as S3 allows for this;
 *   - `X-Amz-Security-Token` when the credentials are temporary — a Lambda's
 *     always are — signed with the rest.
 *
 * presign.test.ts holds it to AWS's own published example, signature and
 * all, and to the SDK's signer for a session token and awkward characters.
 *
 * An address is good for no longer than the credentials that signed it. A
 * Lambda's last hours, so an hour's address may in the worst case end
 * sooner than it says: the television asks again when a picture will not
 * load, and is handed a fresh one.
 *
 * Nothing here is logged, and nothing is kept: the address is returned to
 * whoever is answering the television, and that is the only place it goes.
 *
 * Pure but for `credentialsFromEnv`, which reads what it is handed.
 */
import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** The longest S3 will honour for an address signed this way: seven days. */
const MAX_EXPIRES_SEC = 7 * 24 * 60 * 60;

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest();

/** RFC 3986: everything but the unreserved characters is escaped — the four that encodeURIComponent leaves included. */
const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `20130524T000000Z`, and its day `20130524`. */
function amzDate(now) {
  const iso = new Date(now).toISOString();
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { stamp, day: stamp.slice(0, 8) };
}

/**
 * The role this Lambda runs as, from its environment — or undefined when it
 * is not there (a test, a laptop), in which case nothing is signed.
 */
export function credentialsFromEnv(env = process.env) {
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken, AWS_REGION: region } = env;
  if (!accessKeyId || !secretAccessKey || !region) return undefined;
  return { region, credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } };
}

/**
 * A presigned GET for `key` in `bucket`.
 *
 * @param {object} input
 * @param {string} input.bucket
 * @param {string} input.key          the object's key, as it is (not escaped)
 * @param {string} input.region
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string }} input.credentials
 * @param {number} input.expiresSec   how long the address is good for
 * @param {number} input.now          when it is signed, in milliseconds
 * @param {string} [input.host]       the bucket's host, when it is not the regional one
 * @returns {string} the address
 */
export function presignGet({ bucket, key, region, credentials, expiresSec, now, host }) {
  if (!bucket || !key || !region) throw new Error('an address needs a bucket, a key and a region');
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) throw new Error('an address needs credentials to sign it');
  if (!Number.isInteger(expiresSec) || expiresSec < 1 || expiresSec > MAX_EXPIRES_SEC) throw new Error('an address is good for between a second and seven days');

  const { stamp, day } = amzDate(now);
  const scope = `${day}/${region}/${SERVICE}/aws4_request`;
  const hostname = host ?? `${bucket}.s3.${region}.amazonaws.com`;
  // Each part of the key escaped, the slashes between them kept: S3 escapes a path once.
  const path = `/${key.split('/').map(encode).join('/')}`;

  const query = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expiresSec),
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
    'X-Amz-SignedHeaders': 'host',
  };
  // Sorted by name, as the canonical request wants them (byte order: these names are plain ASCII).
  const canonicalQuery = Object.keys(query).sort().map((name) => `${encode(name)}=${encode(query[name])}`).join('&');

  const canonicalRequest = ['GET', path, canonicalQuery, `host:${hostname}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), SERVICE), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `https://${hostname}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
