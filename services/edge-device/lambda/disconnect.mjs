/** WebSocket $disconnect — clears the connection, only if it is still ours. */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

import { clearExpressions, slotForRole } from './connection-slot.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  const lookup = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));
  if (!lookup.Item) return { statusCode: 200, body: '' };

  const deviceId = lookup.Item.deviceId.S;
  const householdId = lookup.Item.householdId.S;

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      ...clearExpressions(slotForRole(lookup.Item.role?.S)),
      ExpressionAttributeValues: { ':cid': { S: connectionId } },
    }));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err; // a newer connection already replaced it
  }

  await ddb.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));

  return { statusCode: 200, body: '' };
};
