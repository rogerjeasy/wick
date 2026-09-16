/**
 * WebSocket $connect.
 *
 *   - verify the device-bound JWT (RS256), check the deviceId denylist
 *   - store the connectionId on the Device item, plus a reverse lookup so
 *     $disconnect can find it again (API Gateway hands $disconnect nothing
 *     but the connectionId)
 *   - reconcile: the client sends lastSeenCardId in the query string;
 *     anything queued after it goes out now, over this same connection
 *
 * See docs/WICK-TECHNICAL.md §4.1, §4.2.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { verifyJwt } from './jwt.mjs';

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
  const { deviceId, householdId } = claims;

  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
  }));
  if (!device.Item || device.Item.denylisted?.BOOL) {
    return { statusCode: 403, body: 'revoked' };
  }

  const connectionId = event.requestContext.connectionId;
  const wsEndpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `DEV#${deviceId}` },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      denylisted: { BOOL: false },
      connectionId: { S: connectionId },
      transport: { S: 'websocket' },
      wsEndpoint: { S: wsEndpoint },
      connectedAt: { N: String(Date.now()) },
    },
  }));

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `CONN#${connectionId}` },
      sk: { S: 'META' },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) }, // stale-connection backstop
    },
  }));

  await reconcile({ event, householdId, connectionId, wsEndpoint });

  return { statusCode: 200, body: '' };
};

async function reconcile({ event, householdId, connectionId, wsEndpoint }) {
  const sinceCardId = event.queryStringParameters?.lastSeenCardId;

  const pending = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: 'CARD#' },
    },
  }));

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  for (const item of pending.Items ?? []) {
    const card = JSON.parse(item.data.S);
    if (sinceCardId && card.id <= sinceCardId) continue; // ULIDs sort lexicographically by creation time (INV-6)
    try {
      await mgmt.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ kind: 'card', card }),
      }));
    } catch (err) {
      if (err?.name !== 'GoneException') throw err;
    }
  }
}
