/**
 * Live video: WHEP (WebRTC-HTTP Egress Protocol). Ring docs, "WHEP Live
 * Video Streaming"; measured in SP-3 against the Playground camera: 201 in
 * ~1.5s, first RTP ~3.2s after the request.
 *
 *   POST   /v1/devices/{id}/media/streaming/whep/sessions   (application/sdp)
 *          → 201, SDP answer, Location: …/sessions/{session_id}
 *   DELETE {Location}
 *
 * Ring ends a session itself at 30s (battery) or 60s (line power). Closing
 * early is still the caller's job: an open session costs a battery doorbell.
 */
import { RingApiError, type RingClient } from './client.js';

export interface WhepSession {
  readonly answer: string;
  readonly sessionUrl: string;
}

export async function startWhepSession(client: RingClient, deviceId: string, offerSdp: string): Promise<WhepSession> {
  const { text, location } = await client.postText(
    `/v1/devices/${deviceId}/media/streaming/whep/sessions`,
    offerSdp,
    'application/sdp',
  );
  // Without the Location there is no way to close it again.
  if (!location) throw new RingApiError(201, 'NO_LOCATION', 'WHEP session created without a Location header');
  return { answer: text, sessionUrl: location };
}

export async function stopWhepSession(client: RingClient, sessionUrl: string): Promise<void> {
  try {
    await client.deleteUrl(sessionUrl);
  } catch (err) {
    // Ring already ended it (its own time limit) — that is stopped.
    if (err instanceof RingApiError && err.status === 404) return;
    throw err;
  }
}
