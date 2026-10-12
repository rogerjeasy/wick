/**
 * An inbound DeviceEvent over MQTT. §4.3.
 *
 * A topic rule on `wick/device/+/events` hands each message here with the
 * television's id taken from the topic — which the authorizer's policy lets
 * only that television publish to — and never from the message. The
 * household is the one that television is paired to (INV-8). What the event
 * means is device-event.mjs, the same code the WebSocket path runs.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { deviceOwnerKey, householdOfDevice } from './device-owner.mjs';
import { handleDeviceEvent } from './device-event.mjs';
import { SAFE_DEVICE_ID, topicsOf } from './iot-policy.mjs';

const ddb = new DynamoDBClient({});
const iot = new IoTDataPlaneClient({});
const TABLE = process.env.TABLE_NAME;

/**
 * Answers the television on its own topics: a card on `cards`, a control
 * message on `control`, each topic's body bare (as egress.ts publishes
 * them). QoS 1: the broker keeps it until the television has it.
 */
const mqttSender = (deviceId) => {
  const publish = async (topic, body) => {
    await iot.send(new PublishCommand({ topic, qos: 1, payload: Buffer.from(JSON.stringify(body)) }));
    return true;
  };
  return {
    sendCard: (card) => publish(topicsOf(deviceId).cards, card),
    sendControl: (control) => publish(topicsOf(deviceId).control, control),
  };
};

export const handler = async (event) => {
  const deviceId = event?.deviceId;
  if (typeof deviceId !== 'string' || !SAFE_DEVICE_ID.test(deviceId)) return { statusCode: 400, body: 'bad_topic' };

  let deviceEvent;
  try {
    deviceEvent = JSON.parse(Buffer.from(String(event.payload ?? ''), 'base64').toString('utf8'));
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }

  const owner = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: deviceOwnerKey(deviceId) }));
  const householdId = householdOfDevice(owner.Item);
  if (!householdId) return { statusCode: 401, body: 'unknown_device' };

  return handleDeviceEvent({ householdId, deviceId, deviceEvent, ...mqttSender(deviceId) });
};
