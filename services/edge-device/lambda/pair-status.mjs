/**
 * GET /pair/status?code=XXXXXX — the TV polls this until it is bound.
 * Delivers the token exactly once: the pairing nonce is deleted on delivery,
 * so a stolen or replayed code that already delivered gets 404, not a second
 * copy of the token.
 */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  const code = event.queryStringParameters?.code;
  if (!code) return { statusCode: 400, body: 'code_required' };

  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  const item = existing.Item;
  if (!item) return { statusCode: 404, body: 'unknown_or_expired_code' };

  if (!item.claimed?.BOOL) {
    return { statusCode: 200, body: JSON.stringify({ status: 'pending' }) };
  }

  const token = JSON.parse(item.deliveryToken.S);
  await ddb.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  return { statusCode: 200, body: JSON.stringify({ status: 'bound', token }) };
};
