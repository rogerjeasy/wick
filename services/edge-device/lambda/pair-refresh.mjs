/**
 * POST /pair/refresh {deviceId, householdId} — mints a fresh device-bound
 * JWT for a device that is already paired, without going through a new
 * six-digit code.
 *
 * Exists because CardService.ts (apps/tv-vega) runs in a process separate
 * from App.tsx with no shared JS memory, and on the Vega Virtual Device
 * `/data` never actually holds a written file (FRICTION.md FL-013) — so the
 * on-disk token cache both processes normally share can never actually do
 * its job. This endpoint makes the durable deviceId<->householdId binding
 * pair-claim.mjs already writes to `HH#{householdId}/DEV#{deviceId}` the
 * real source of truth for "is this device paired", instead of that broken
 * local disk file.
 *
 * SECURITY NOTE (root cause: FRICTION.md FL-013): this endpoint has no proof of
 * possession — deviceId and householdId are the only inputs, and in this
 * app both are hardcoded public constants (apps/tv-vega/src/deviceId.ts,
 * docs/pair/index.html), readable by anyone with the repo. That means
 * anyone can mint a device-bound token here without ever touching the
 * paired TV or the six-digit code flow. The textbook fix — a client-held
 * asymmetric keypair, proof-of-possession on refresh — doesn't work in this
 * codebase today: the client can't persist anything reliably (the same
 * broken /data this file's own first paragraph describes), and since this
 * repo is open source, no client-embedded secret would be confidential
 * either. Accepted, bounded trade-off instead: INV-1 already scopes what
 * this token can do (no Ring/family-surface access — see PairingFlow.ts),
 * REFRESH_TOKEN_TTL_SEC below is far shorter than a real pairing's token so
 * a wrongly-minted one expires fast, and the cooldown throttles repeated
 * minting. This does not stop a single unauthenticated mint; revisit if
 * SP-8 (real Fire TV hardware, FRICTION.md Open Slots) shows on-device
 * storage actually works there, since that would make real proof-of-
 * possession viable.
 */
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt } from './jwt.mjs';
import { REFRESH_TOKEN_TTL_SEC, REFRESH_MIN_INTERVAL_MS } from './pairing-code.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME;
const SIGNING_KEY_SECRET_ARN = process.env.PAIRING_SIGNING_KEY_SECRET_ARN;

let cachedPrivateKey = null;
async function privateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
  cachedPrivateKey = JSON.parse(r.SecretString).privateKeyPem;
  return cachedPrivateKey;
}

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }
  const { deviceId, householdId } = body;
  if (!deviceId || !householdId) return { statusCode: 400, body: 'deviceId_and_householdId_required' };

  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
  }));
  const item = existing.Item;
  if (!item) return { statusCode: 404, body: 'device_not_paired' };
  if (item.denylisted?.BOOL) return { statusCode: 403, body: 'device_denylisted' };

  // Throttle, not an auth check: bounds repeated/automated minting. A single
  // caller only needs one successful call to get a token, so this doesn't
  // defend against that — see this file's header comment for the real trade-off.
  const now = Date.now();
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      UpdateExpression: 'SET lastRefreshAt = :now',
      ConditionExpression: 'attribute_not_exists(lastRefreshAt) OR lastRefreshAt < :cutoff',
      ExpressionAttributeValues: {
        ':now': { N: String(now) },
        ':cutoff': { N: String(now - REFRESH_MIN_INTERVAL_MS) },
      },
    }));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    return { statusCode: 429, body: 'refresh_rate_limited' };
  }

  const key = await privateKey();
  const jwt = signJwt({ deviceId, householdId }, key, { expiresInSec: REFRESH_TOKEN_TTL_SEC });
  const token = { jwt, deviceId, householdId, expiresAt: Date.now() + REFRESH_TOKEN_TTL_SEC * 1000 };

  return { statusCode: 200, body: JSON.stringify({ token }) };
};
