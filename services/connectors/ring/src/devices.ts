/** GET /v1/devices[?include=status,capabilities,location,configurations] */
import type { RingClient } from './client.js';
import { unwrap, parseDevice } from './jsonapi.js';
import type { RingDevice } from './types.js';

const INCLUDE = 'status,capabilities,location';

export async function listDevices(client: RingClient): Promise<RingDevice[]> {
  const doc = await client.get(`/v1/devices?include=${INCLUDE}`);
  const { items, included } = unwrap(doc);
  return items.map((item) => parseDevice(item, included));
}

/** The device a door event came from, or undefined if it is no longer listed. */
export async function findDevice(
  client: RingClient,
  deviceId: string,
): Promise<RingDevice | undefined> {
  return (await listDevices(client)).find((d) => d.id === deviceId);
}
