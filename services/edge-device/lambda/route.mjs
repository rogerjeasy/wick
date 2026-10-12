/**
 * WebSocket `$default` — an inbound DeviceEvent over API Gateway. §4.3.
 *
 * This file is only the WebSocket's half: which television a connection
 * belongs to, and how to answer on that connection. What an event means is
 * device-event.mjs, shared with the MQTT path (iot-events.mjs).
 *
 * reconcile: the client sends `{ t: 'reconcile', sinceCardId }` as a normal
 * message on open, and the cards it is owed come back on this same
 * connection — API Gateway populates requestContext.domainName/stage on
 * every WebSocket route, not just $connect, so the endpoint to answer on is
 * derived here rather than stored.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { handleDeviceEvent } from './device-event.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

/**
 * Answers on the connection the event came in on: a card, or a control
 * message. Each says false once that connection has gone.
 */
function webSocketSender(event, connectionId) {
  const mgmt = new ApiGatewayManagementApiClient({
    endpoint: `https://${event.requestContext.domainName}/${event.requestContext.stage}`,
  });
  const post = async (message) => {
    try {
      await mgmt.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: JSON.stringify(message) }));
      return true;
    } catch (err) {
      if (err?.name === 'GoneException') return false;
      throw err;
    }
  };
  return {
    sendCard: (card) => post({ kind: 'card', card }),
    sendControl: (control) => post({ kind: 'control', control }),
  };
}

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let deviceEvent;
  try {
    deviceEvent = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }

  const lookup = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));
  if (!lookup.Item) return { statusCode: 401, body: 'unknown_connection' };

  return handleDeviceEvent({
    householdId: lookup.Item.householdId.S,
    deviceId: lookup.Item.deviceId.S,
    deviceEvent,
    ...webSocketSender(event, connectionId),
  });
};
