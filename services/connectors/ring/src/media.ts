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
import { RingApiError, type RingClient } from './client.js';
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

/** JPEG starts FF D8 FF; PNG starts 89 50 4E 47. */
export function looksLikeImage(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return jpeg || png;
}

/**
 * Pull the bytes behind a presigned URL, and refuse anything that is not an
 * image.
 *
 * The media host answers 200-shaped failures with a JSON error body — seen in
 * the wild as
 *
 *   422 GRECO_NO_VALID_KEY  "No valid Greco key available for decryption"
 *
 * which, written straight to disk, produces a 201-byte file called .jpg that
 * every later step treats as a picture. The vision model then describes
 * nothing, and the reason surfaces three layers away from the cause. Checking
 * the magic bytes here turns that into one clear error at the source.
 */
export async function fetchImageBytes(
  image: RingImage,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await fetchImpl(image.url);
  const bytes = new Uint8Array(await res.arrayBuffer());

  if (!res.ok || !looksLikeImage(bytes)) {
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes.slice(0, 2048))) as {
        errors?: { code?: string; detail?: string; status?: string }[];
      };
      const first = body.errors?.[0];
      code = first?.code ?? null;
      detail = first?.detail ?? null;
      throw new RingApiError(Number(first?.status ?? res.status), code, detail);
    } catch (err) {
      if (err instanceof RingApiError) throw err;
      throw new RingApiError(res.status, 'NOT_AN_IMAGE',
        `media host returned ${bytes.length} bytes that are not an image`);
    }
  }

  return bytes;
}

/**
 * The frame for an event, retried.
 *
 * Empirically the media host fails a majority of first attempts right after an
 * event with
 *
 *   422 GRECO_NO_VALID_KEY  "No valid Greco key available for decryption"
 *
 * and then succeeds on a later try — 2 of 5 captures survived without this.
 * The reading is that the decryption key has not propagated by the time the
 * history entry is visible. Ring documents neither the error nor a settling
 * time, so the delay here is measured rather than specified (FL-008).
 *
 * Each attempt re-requests the presigned URL: they are short-lived, and
 * re-using a stale one would swap this failure for a less obvious one.
 */
export async function imageForEvent(
  client: RingClient,
  deviceId: string,
  event: { readonly start: number; readonly end?: number },
  options: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
  } = {},
): Promise<{ image: RingImage; bytes: Uint8Array; attempts: number }> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 2000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  let last: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const image = await imageAt(client, deviceId, selectorForEvent(event), now());
      return { image, bytes: await fetchImageBytes(image, client.fetchImpl), attempts: attempt };
    } catch (err) {
      last = err;
      // Only the key-propagation failure is worth waiting out. A 400 on the
      // body shape or a 401 on the token will never fix itself.
      const retryable = err instanceof RingApiError && err.code === 'GRECO_NO_VALID_KEY';
      if (!retryable || attempt === attempts) break;
      await sleep(delayMs);
    }
  }

  throw last;
}
