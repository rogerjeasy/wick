/**
 * Which household a Ring device belongs to: `RINGDEV#<deviceId>` / `META`.
 *
 * A deployment has one Ring link, and one Ring account can hold the
 * doorbells and chimes of more than one home. A ring carries only a device
 * id, so this is what says whose television it reaches — and whose chime a
 * button may sound. The same shape as a television's owner
 * (edge-device/lambda/device-owner.mjs), for the same reason: a device
 * belongs to one household, and the claim is conditional so one home can
 * never take over another's doorbell.
 *
 * `send` is a DynamoDBClient's send, injected so the exact requests are
 * tested without AWS.
 */
import { GetItemCommand, PutItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import type { RingDevice } from '@wick/ring';

export type DdbSend = (command: { readonly input: object }) => Promise<{ Item?: Record<string, AttributeValue> | undefined }>;

export interface RingDeviceOwners {
  householdOf(deviceId: string): Promise<string | undefined>;
  /** False when another household already holds the device. */
  assign(deviceId: string, householdId: string): Promise<boolean>;
}

export function ringDeviceOwners(send: DdbSend, table: string, now: () => number = Date.now): RingDeviceOwners {
  const key = (deviceId: string): Record<string, AttributeValue> => ({ pk: { S: `RINGDEV#${deviceId}` }, sk: { S: 'META' } });

  return {
    async householdOf(deviceId) {
      // Consistent: a doorbell handed to a household must reach it on the very next ring.
      const item = (await send(new GetItemCommand({ TableName: table, Key: key(deviceId), ConsistentRead: true }))).Item;
      return item?.householdId?.S || undefined;
    },

    async assign(deviceId, householdId) {
      try {
        await send(new PutItemCommand({
          TableName: table,
          Item: { ...key(deviceId), householdId: { S: householdId }, assignedAt: { N: String(now()) } },
          ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
          ExpressionAttributeValues: { ':hh': { S: householdId } },
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
  };
}

/**
 * The devices on the linked Ring account that this household holds. A
 * device nobody holds is nobody's: it is left out, never shared.
 */
export async function devicesOfHousehold(
  householdId: string,
  devices: readonly RingDevice[],
  householdOf: (deviceId: string) => Promise<string | undefined>,
): Promise<RingDevice[]> {
  const holders = await Promise.all(devices.map((d) => householdOf(d.id)));
  return devices.filter((_, i) => holders[i] === householdId);
}
