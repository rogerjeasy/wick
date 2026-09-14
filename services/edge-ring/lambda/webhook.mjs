/**
 * Ring webhook receiver.
 *
 * The entire design is Ring's five-second acknowledgement budget:
 *
 *   1. verify HMAC-SHA256 (constant time)
 *   2. idempotency: conditional PutItem on request_id, TTL 24h
 *   3. PutEvents -> EventBridge
 *   4. return 200
 *
 * Nothing else on this path. No Ring API calls, no model calls, no extra writes.
 * Everything downstream is async off the bus. Target p99 < 150ms.
 *
 * INV-6: correlationId is minted HERE and must survive to the device.
 * See docs/WICK-TECHNICAL.md §7.1, §9.1.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddb = new DynamoDBClient({});
const bus = new EventBridgeClient({});
const sm = new SecretsManagerClient({});

const TABLE = process.env.TABLE_NAME;
const BUS = process.env.BUS_NAME;
const SECRET_ARN = process.env.RING_SECRET_ARN;

let cachedKey = null;          // container-scoped; avoids a Secrets call per event

async function hmacKey() {
  if (cachedKey) return cachedKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  cachedKey = JSON.parse(r.SecretString).hmacKey;
  return cachedKey;
}

function verify(rawBody, signature, key) {
  if (!signature) return false;
  const expected = createHmac('sha256', key).update(rawBody, 'utf8').digest('hex');
  const given = signature.replace(/^sha256=/, '').trim();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const handler = async (event) => {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const signature =
    headers['x-ring-signature'] ?? headers['x-amz-signature'] ?? headers['x-signature'];

  // 1 — authenticity
  let key;
  try {
    key = await hmacKey();
  } catch {
    console.error(JSON.stringify({ level: 'error', msg: 'secret_unavailable' }));
    return { statusCode: 500, body: '' };
  }
  if (!verify(raw, signature, key)) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'bad_signature' }));
    return { statusCode: 401, body: '' };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: '' };
  }

  const requestId = payload.request_id ?? payload.requestId;
  if (!requestId) return { statusCode: 400, body: '' };

  // 2 — idempotency. A duplicate is a success, not an error: Ring retries, and a
  //     non-200 would make it retry harder.
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: `IDEM#${requestId}` },
        sk: { S: 'META' },
        ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return { statusCode: 200, body: '' };      // already seen
    }
    console.error(JSON.stringify({ level: 'error', msg: 'idem_failed', err: e.name }));
    return { statusCode: 500, body: '' };
  }

  // 3 — hand off and get out of the way
  const correlationId = randomUUID();
  try {
    await bus.send(new PutEventsCommand({
      Entries: [{
        EventBusName: BUS,
        Source: 'wick.ring',
        DetailType: payload.event_type ?? payload.type ?? 'unknown',
        Detail: JSON.stringify({ ...payload, correlationId, receivedAt: Date.now() }),
      }],
    }));
  } catch {
    console.error(JSON.stringify({ level: 'error', msg: 'bus_failed', correlationId }));
    return { statusCode: 500, body: '' };
  }

  console.log(JSON.stringify({
    level: 'info', msg: 'accepted', correlationId,
    type: payload.event_type ?? payload.type, requestId,
  }));
  return { statusCode: 200, body: '' };
};
