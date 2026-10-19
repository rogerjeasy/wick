/**
 * When Wick tells the platform what she is watching — Amazon's "When to
 * Send" rules for Watch Activity (Vega docs, Content Personalization →
 * Watch Activity), applied to the player's once-a-second snapshots:
 *
 *   - on a change of playback state: start, pause, stop or exit;
 *   - on seeking to a new position (her 30-second skips, "start over");
 *   - once every 60 seconds while in the player, whatever the state.
 *
 * BUFFERING is not a state the platform has, so it is neither reported nor
 * counted as a change. A film that has
 * ended is EXIT, which is also what is sent when she leaves the film.
 *
 * Pure: the clock is passed in, and the report itself is report.ts's.
 */
import type { PlayerSnapshot } from '../player/PlayerService.js';

/** The platform's own three reportable states (kepler-content-personalization's PlaybackState): no BUFFERING, no INTERSTITIAL (Wick has neither ads nor a use for reporting transient buffering). */
export type ReportablePlaybackState = 'PLAYING' | 'PAUSED' | 'EXIT';

/** Amazon's interval while in the player. */
export const REPORT_EVERY_MS = 60_000;

/**
 * How far the position may stray from where playing on would have taken it
 * before it counts as a seek. Snapshots come once a second and the player's
 * clock is not the app's, so a little slack; her shortest skip is 30 s.
 */
export const SEEK_SLACK_MS = 3_000;

export interface WatchReport {
  readonly contentId: string;
  readonly state: ReportablePlaybackState;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly creditsPositionMs?: number;
}

function reportableState(state: PlayerSnapshot['state']): ReportablePlaybackState | undefined {
  if (state === 'PLAYING') return 'PLAYING';
  if (state === 'PAUSED') return 'PAUSED';
  if (state === 'STOPPED') return 'EXIT';
  return undefined;
}

export class WatchActivity {
  /** The last snapshot seen, and when: where playing on would have taken the film. */
  #seen: { readonly contentId: string; readonly state: ReportablePlaybackState; readonly positionMs: number; readonly at: number } | undefined;
  #reportedAt: number | undefined;

  /** The report this snapshot calls for, if any. Call with every snapshot, in order. */
  next(snapshot: PlayerSnapshot, now: number): WatchReport | undefined {
    const state = reportableState(snapshot.state);
    if (!state) return undefined;
    const seen = this.#seen;
    this.#seen = { contentId: snapshot.contentId, state, positionMs: snapshot.positionMs, at: now };

    const due =
      seen === undefined ||
      seen.contentId !== snapshot.contentId ||
      seen.state !== state ||
      Math.abs(snapshot.positionMs - (seen.positionMs + (seen.state === 'PLAYING' ? now - seen.at : 0))) > SEEK_SLACK_MS ||
      this.#reportedAt === undefined ||
      now - this.#reportedAt >= REPORT_EVERY_MS;
    if (!due) return undefined;

    this.#reportedAt = now;
    return {
      contentId: snapshot.contentId,
      state,
      positionMs: snapshot.positionMs,
      durationMs: snapshot.durationMs,
      ...(snapshot.creditsPositionMs !== undefined ? { creditsPositionMs: snapshot.creditsPositionMs } : {}),
    };
  }

  /** She has left the player: the next film starts afresh. */
  reset(): void {
    this.#seen = undefined;
    this.#reportedAt = undefined;
  }
}
