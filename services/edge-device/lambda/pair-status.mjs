/**
 * GET /pair/status?code=XXXXXX — the TV polls this until it is bound.
 * Delivers the token exactly once: the pairing nonce is atomically deleted
 * on delivery via a single conditional DeleteItem, so a stolen or replayed
 * code that already delivered gets 404, not a second copy of the token —
 * and two concurrent in-flight polls (the expected case for a polling
 * loop, not an exotic one) can never both walk away with the token.
 *
 * With the token goes the secret pair-claim.mjs made for a television that
 * asked for one (`keeps`, proof.mjs) — in the same delete, so it too is
 * handed over once, to the television polling its own code, and then exists
 * nowhere but there and, as a hash, on its row.
 *
 * `createHandler` takes its DynamoDB send, so it is tested without AWS
 * (__tests__/pair-status.test.ts).
 */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

export function createHandler({ send, table }) {
  return async (event) => {
    const code = event.queryStringParameters?.code;
    if (!code) return { statusCode: 400, body: 'code_required' };

    const key = { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } };

    // The delete itself is the single atomic operation that decides who wins:
    // ConditionExpression 'claimed = :true' means at most one concurrent
    // caller's DeleteItem can succeed for a given item (DynamoDB evaluates
    // the condition and applies the mutation atomically), and only the
    // winner gets Attributes back via ReturnValues. Losers — whether the
    // code is still pending or was already delivered by another winner —
    // land in the catch block below and never see a token twice.
    try {
      const result = await send(new DeleteItemCommand({
        TableName: table,
        Key: key,
        ConditionExpression: 'claimed = :true',
        ExpressionAttributeValues: { ':true': { BOOL: true } },
        ReturnValues: 'ALL_OLD',
      }));
      const token = JSON.parse(result.Attributes.deliveryToken.S);
      const proof = result.Attributes.deliveryProof?.S;
      return { statusCode: 200, body: JSON.stringify({ status: 'bound', token, ...(proof ? { proof } : {}) }) };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      // The condition failed, meaning either the item is still pending
      // (claimed = false) or it's gone (delivered to a concurrent winner, or
      // never existed / expired). DynamoDB's error alone doesn't say which,
      // so disambiguate with a follow-up GetItem — off the hot/winning path,
      // so it doesn't affect the exactly-once guarantee above, only which
      // non-token response this particular loser gets.
      const existing = await send(new GetItemCommand({ TableName: table, Key: key }));
      if (!existing.Item) return { statusCode: 404, body: 'unknown_or_expired_code' };
      return { statusCode: 200, body: JSON.stringify({ status: 'pending' }) };
    }
  };
}

const ddb = new DynamoDBClient({});

export const handler = createHandler({ send: (command) => ddb.send(command), table: process.env.TABLE_NAME });
