/**
 * Which of the player's once-a-second snapshots are worth keeping.
 *
 * A change of state or of programme is an event; the 600 identical PLAYING
 * snapshots in between are not (§4.3: "no reason to be chatty"). BUFFERING
 * is never recorded and never counts as a change — it is a device-local
 * hiccup, not something the resident did (the platform's own vocabulary has
 * no such state either: personalization/watchActivity.ts).
 */
import type { DeviceEvent } from '@wick/contracts';
import type { PlayerSnapshot } from '../player/PlayerService.js';

export class PlaybackRecorder {
  #lastKey: string | undefined;

  shouldRecord(snapshot: PlayerSnapshot): boolean {
    if (snapshot.state === 'BUFFERING') return false;
    const key = `${snapshot.contentId}:${snapshot.state}`;
    if (key === this.#lastKey) return false;
    this.#lastKey = key;
    return true;
  }
}

export function toPlaybackDeviceEvent(snapshot: PlayerSnapshot, at: number): DeviceEvent {
  return {
    t: 'playback',
    state: snapshot.state,
    positionMs: snapshot.positionMs,
    durationMs: snapshot.durationMs,
    ...(snapshot.creditsPositionMs !== undefined ? { creditsPositionMs: snapshot.creditsPositionMs } : {}),
    contentId: snapshot.contentId,
    at,
  };
}
