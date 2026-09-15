/** GET /v1/history/devices/{id}/events — carer verification (M5), and the
 *  source of the timestamp that the image retrieval needs (FL-005). */
import type { RingClient } from './client.js';
import { unwrap, parseHistoryEvent } from './jsonapi.js';
import type { RingHistoryEvent } from './types.js';

export async function listEvents(
  client: RingClient,
  deviceId: string,
): Promise<RingHistoryEvent[]> {
  const doc = await client.get(`/v1/history/devices/${deviceId}/events`);
  const { items } = unwrap(doc);
  return items
    .map((item) => parseHistoryEvent(item, deviceId))
    .sort((a, b) => b.start - a.start);
}

export async function latestEvent(
  client: RingClient,
  deviceId: string,
): Promise<RingHistoryEvent | undefined> {
  return (await listEvents(client, deviceId))[0];
}
