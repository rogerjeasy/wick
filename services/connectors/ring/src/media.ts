/**
 * Media retrieval.
 *
 *   Image      POST /v1/devices/{id}/media/image/download
 *   Live       POST /v1/devices/{id}/media/streaming/whep/sessions  (application/sdp)
 *   RTSP alt   rtsps://video.rtsp.amazonvision.com:322/v1/devices/{id}/stream
 *   Chime      POST /v1/devices/{id}/media/audio/playback           <- M1, requires Chime Controls
 *
 * Multi-module cameras: append ?component_id=N.
 * All server-to-server. Ring blocks browser and TV origins on api.amazonvision.com.
 *
 * THE IMAGE CALL IS NOT A SNAPSHOT. There is no live-capture endpoint. This
 * retrieves a recorded frame, and it needs the type/timestamp body below —
 * neither of which is documented. Verified against the live API 2026-09-15,
 * written up as FL-005.
 */
import type { RingClient } from './client.js';
import type { RingImage } from './types.js';

/**
 * `at_timestamp` takes a single instant; `latest_in_range` takes a window.
 * These two values are the entire supported enum — the API told us so in a
 * validation error, which is the only place they appear.
 */
export type ImageSelector =
  | { readonly type: 'at_timestamp'; readonly timestamp: number }
  | { readonly type: 'latest_in_range'; readonly start: number; readonly end: number };

/**
 * The presigned URL for a recorded frame.
 *
 * Costs one round trip (~0.8s measured) because the redirect is not followed.
 * Pulling the bytes as well took ~3.15s in total, which is why the Door Card
 * treats the image as a patch and never waits for it.
 */
export async function imageAt(
  client: RingClient,
  deviceId: string,
  selector: ImageSelector,
  now: number = Date.now(),
): Promise<RingImage> {
  const url = await client.postForRedirect(
    `/v1/devices/${deviceId}/media/image/download`,
    selector,
  );

  return {
    url,
    capturedAt: selector.type === 'at_timestamp' ? selector.timestamp : selector.end,
    fetchedAt: now,
  };
}

/**
 * The frame for a door event: just after it starts, so the visitor is in shot
 * rather than the empty doorstep that preceded them.
 */
export function selectorForEvent(event: {
  readonly start: number;
  readonly end?: number;
}): ImageSelector {
  return { type: 'at_timestamp', timestamp: event.end ?? event.start };
}
