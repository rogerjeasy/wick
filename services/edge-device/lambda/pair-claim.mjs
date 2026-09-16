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
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
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

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `DEV#${deviceId}` },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      denylisted: { BOOL: false },
      pairedAt: { N: String(Date.now()) },
    },
  }));

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
    UpdateExpression: 'SET claimed = :true, deliveryToken = :tok',
    ExpressionAttributeValues: {
      ':true': { BOOL: true },
      ':tok': { S: JSON.stringify({ jwt, deviceId, householdId, expiresAt: tokenExpiresAt }) },
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
