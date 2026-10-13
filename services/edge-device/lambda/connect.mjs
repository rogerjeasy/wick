/**
 * WebSocket $connect.
 *
 *   - verify the device-bound JWT (RS256), check the deviceId denylist
 *   - store the connectionId on the Device item — in the foreground slot, or
 *     the background slot for the app's card service (`?role=background`,
 *     connection-slot.mjs) — plus a reverse lookup so $disconnect can find
 *     it again (API Gateway hands $disconnect nothing but the connectionId)
 *
 * Reconcile (replaying queued cards since the client's last-seen card) does
 * NOT happen here: the client never puts that in the connect query string —
 * it sends `{ t: 'reconcile', sinceCardId }` as a normal message once the
 * socket is open (see apps/tv-vega/src/transport/WebSocketChannel.ts), which
 * lands on the $default route. See route.mjs.
 *
 * See docs/WICK-TECHNICAL.md §4.1, §4.2.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { verifyJwt } from './jwt.mjs';
import { setExpression, slotForRole } from './connection-slot.mjs';
import { deviceBindingKey, isResidentsToken, isServed } from './device-standing.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME;
const SIGNING_KEY_SECRET_ARN = process.env.PAIRING_SIGNING_KEY_SECRET_ARN;

let cachedPublicKey = null;
async function publicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
  cachedPublicKey = JSON.parse(r.SecretString).publicKeyPem;
  return cachedPublicKey;
}

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 401, body: 'token_required' };

  let claims;
  try {
    claims = verifyJwt(token, await publicKey());
  } catch {
    return { statusCode: 401, body: 'invalid_token' };
  }
  // The resident's channel is for the resident's television (device-standing.mjs).
  if (!isResidentsToken(claims)) return { statusCode: 403, body: 'not_this_channel' };
  const { deviceId, householdId } = claims;

  // Fast path only: this GetItem is eventually consistent, so a denylist
  // revocation written moments ago can be invisible here. The real
  // enforcement is the ConditionExpression on the UpdateItem below — this
  // check exists purely to return 403 early without attempting the write.
  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: deviceBindingKey(householdId, deviceId),
  }));
  if (!isServed(device.Item)) {
    return { statusCode: 403, body: 'revoked' };
  }

  const connectionId = event.requestContext.connectionId;
  // The app on screen, or its card service behind another app (connection-slot.mjs).
  const slot = slotForRole(event.queryStringParameters?.role);
  const wsEndpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  // UpdateItem, not PutItem: a full-item replace here would silently erase
  // `pairedAt` (set by pair-claim.mjs) and — because the GetItem above is
  // only a fast path — could permanently overwrite a `denylisted: true`
  // written in the gap between the read and this write. The
  // ConditionExpression is the actual guarantee, matching how
  // pair-claim.mjs treats its own preceding GetItem as a fast path only.
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      UpdateExpression: setExpression(slot),
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(denylisted) OR denylisted = :false)',
      ExpressionAttributeValues: {
        ':c': { S: connectionId },
        ':t': { S: 'websocket' },
        ':w': { S: wsEndpoint },
        ':ca': { N: String(Date.now()) },
        ':false': { BOOL: false },
      },
    }));
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return { statusCode: 403, body: 'revoked' };
    throw err;
  }

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `CONN#${connectionId}` },
      sk: { S: 'META' },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      role: { S: slot.role },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) }, // stale-connection backstop
    },
  }));

  return { statusCode: 200, body: '' };
};
