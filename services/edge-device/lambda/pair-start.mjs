/**
 * POST /pair/start {deviceId} -> {code, url, expiresAt}
 * TV boots unpaired, calls this once, displays the code and URL.
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { generatePairingCode, PAIRING_CODE_TTL_MS } from './pairing-code.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const PAIRING_URL_BASE = process.env.PAIRING_URL_BASE;

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }
  const deviceId = body.deviceId;
  if (!deviceId) return { statusCode: 400, body: 'deviceId_required' };

  const now = Date.now();
  const expiresAt = now + PAIRING_CODE_TTL_MS;

  // Retry on the rare collision with a still-live code — the conditional
  // PutItem is the correctness guarantee, this loop is just about not failing
  // the one-in-a-million case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode();
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `PAIR#${code}` },
          sk: { S: 'META' },
          deviceId: { S: deviceId },
          claimed: { BOOL: false },
          expiresAt: { N: String(expiresAt) },
          ttl: { N: String(Math.floor(expiresAt / 1000)) },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return {
        statusCode: 200,
        body: JSON.stringify({ code, url: `${PAIRING_URL_BASE}/${code}`, expiresAt }),
      };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  return { statusCode: 503, body: 'code_space_exhausted' };
};
