/**
 * M2 — Watch live. The television asks for a live session over HTTPS with
 * its device token; the agent plane bridges Ring's WHEP stream to HLS the
 * television's own player can play (spec §4.3, FL-015, FL-016).
 */

export interface LiveSessionRequest {
  readonly cardId: string;
}

export interface LiveSessionResponse {
  readonly sessionId: string;
  /** HTTPS HLS playlist. May 404 for the first few seconds while the bridge starts. */
  readonly playlistUrl: string;
  /** Epoch ms. Ring ends the session by then; the view closes itself. */
  readonly endsAt: number;
}

/** Why there is no picture, in terms the view can say plainly. */
export type LiveRefusal =
  | 'no_such_card'
  | 'card_too_old'
  | 'camera_unavailable'
  | 'camera_unsupported';

export interface LiveErrorResponse {
  readonly error: LiveRefusal | 'unauthorized' | 'bad_request' | 'internal';
}

/** Ring's ceiling for a line-powered doorbell; battery ones end at 30s. */
export const LIVE_MAX_MS = 60_000;

/**
 * A live view is only obtainable while someone is plausibly at the door:
 * for a DOOR card this recent. It bounds what an extracted device token can
 * watch — and what a token minted from a television's id alone can, where
 * that television keeps no secret (INV-1's accepted exception, /pair/refresh).
 */
export const LIVE_CARD_MAX_AGE_MS = 5 * 60_000;

/** How long the view waits for the first playlist before saying the camera isn't answering. */
export const LIVE_FIRST_PICTURE_TIMEOUT_MS = 12_000;
