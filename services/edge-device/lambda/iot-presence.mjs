/**
 * A television came onto, or left, the MQTT channel.
 *
 * IoT Core publishes its own connect and disconnect events
 * (`$aws/events/presence/…`), and a topic rule hands them here. This keeps
 * the one row that answers "how is this television reached" — the same
 * HH#/DEV# row connect.mjs and disconnect.mjs keep for the WebSocket — so
 * the agent plane's egress.ts sends a card down whichever channel is open.
 *
 * The client id is the television's id: the authorizer's policy lets a
 * token connect under no other name. The household is looked up from the
 * television (device-owner.mjs), never taken from the event (INV-8). A
 * client id Wick does not know is someone else's client, and is ignored.
 */
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { deviceOwnerKey, householdOfDevice } from './device-owner.mjs';
import { SAFE_DEVICE_ID, presenceConnected, presenceDisconnected, presenceGone } from './iot-policy.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

/** Best effort: a television that was unpaired meanwhile, or a later disconnect already noted. */
async function remember(update) {
  try {
    await ddb.send(new UpdateItemCommand(update));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }
}

export const handler = async (event) => {
  const { clientId: deviceId, eventType, sessionIdentifier, timestamp, versionNumber } = event ?? {};
  if (typeof deviceId !== 'string' || !SAFE_DEVICE_ID.test(deviceId) || typeof sessionIdentifier !== 'string') return;
  if (eventType !== 'connected' && eventType !== 'disconnected') return;

  const owner = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: deviceOwnerKey(deviceId) }));
  const householdId = householdOfDevice(owner.Item);
  if (!householdId) return;

  const at = typeof timestamp === 'number' ? timestamp : Date.now();
  // Without a version (IoT Core always sends one) every event counts as one connection's.
  const version = typeof versionNumber === 'number' ? versionNumber : -1;
  const row = { table: TABLE, householdId, deviceId, sessionIdentifier, version, at };
  const update = eventType === 'connected' ? presenceConnected(row) : presenceDisconnected(row);
  try {
    await ddb.send(new UpdateItemCommand(update));
    console.log(JSON.stringify({ level: 'info', msg: `mqtt_${eventType}`, deviceId }));
  } catch (err) {
    // Connected: revoked, never paired, or out of date. Disconnected: the
    // row names another connection. See iot-policy.mjs for the rule.
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    console.log(JSON.stringify({ level: 'info', msg: `mqtt_${eventType}_not_applied`, deviceId }));
    if (eventType === 'disconnected') await remember(presenceGone(row));
  }
};
