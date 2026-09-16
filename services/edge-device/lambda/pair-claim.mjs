/**
 * POST /pair/claim {code, householdId} — Sarah's device confirms binding.
 *
 * Household identity is simplified for this pass: no Amazon-account sign-in
 * exists anywhere in this repo (see the plan's Scope decisions and
 * FRICTION.md), so a household is provisioned out of band and its id passed
 * in directly — matching how `environment = dev | home` already models
 * "there is one real household" (§13.3).
 *
 * Binds deviceId <-> householdId, mints the device-bound JWT (§4.2 step 3),
 * and stores it on the pairing nonce for the TV's next poll to collect.
 */
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt } from './jwt.mjs';
import { isExpired, DEVICE_TOKEN_TTL_SEC } from './pairing-code.mjs';

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
  const { code, householdId } = body;
  if (!code || !householdId) return { statusCode: 400, body: 'code_and_householdId_required' };

  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  const item = existing.Item;
  if (!item) return { statusCode: 404, body: 'unknown_or_expired_code' };
  if (isExpired({ expiresAt: Number(item.expiresAt.N) })) return { statusCode: 410, body: 'code_expired' };
  if (item.claimed?.BOOL) return { statusCode: 409, body: 'already_claimed' };

  const deviceId = item.deviceId.S;
  const key = await privateKey();
  const jwt = signJwt({ deviceId, householdId }, key, { expiresInSec: DEVICE_TOKEN_TTL_SEC });
  const tokenExpiresAt = Date.now() + DEVICE_TOKEN_TTL_SEC * 1000;

  // Atomically claim the pairing code BEFORE writing the device binding.
  // This is the sole correctness guarantee against two concurrent claims of
  // the same code (INV-1: exactly one household per device): the read above
  // is only a fast-path/UX check (404/410 messages), not the gate. Exactly
  // one concurrent caller can win this conditional update; the loser hits
  // ConditionalCheckFailedException below and never writes a device binding.
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
      UpdateExpression: 'SET claimed = :true, deliveryToken = :tok',
      ConditionExpression: 'attribute_exists(pk) AND claimed = :false',
      ExpressionAttributeValues: {
        ':true': { BOOL: true },
        ':false': { BOOL: false },
        ':tok': { S: JSON.stringify({ jwt, deviceId, householdId, expiresAt: tokenExpiresAt }) },
      },
    }));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    // The condition is a conjunction, so DynamoDB doesn't tell us which half
    // failed. The item existed and was unclaimed at the GetItem above a
    // moment ago, so the overwhelmingly likely cause is a concurrent claim
    // winning the race — 409 is the right status for that case, and the
    // rare alternative (the item vanished entirely between the read and the
    // write) doesn't have a code of its own in this API's contract anyway,
    // so collapsing to 409 here is the closer match: an unauthenticated
    // client can't tell "raced" from "expired-in-between" apart in a way
    // that would change what it does next (re-poll status / re-request a
    // code), and 409 doesn't falsely imply the code was never valid the way
    // 404 would for what was, a moment ago, a real code.
    return { statusCode: 409, body: 'already_claimed' };
  }

  // Bind deviceId <-> householdId without clobbering an existing denylist
  // flag: this row may already exist for this device from a prior pairing
  // that was since denylisted, and re-pairing must not silently restore
  // access. UpdateItem + if_not_exists only initializes `denylisted` to
  // false when the attribute is not already present; an existing `true`
  // survives untouched.
  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
    UpdateExpression:
      'SET deviceId = :did, householdId = :hhid, pairedAt = :pa, denylisted = if_not_exists(denylisted, :false)',
    ExpressionAttributeValues: {
      ':did': { S: deviceId },
      ':hhid': { S: householdId },
      ':pa': { N: String(Date.now()) },
      ':false': { BOOL: false },
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
