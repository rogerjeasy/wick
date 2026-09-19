/**
 * Ties PlayerService's snapshots and the app's foreground lifecycle to
 * NaturalBreakEngine, and picks the single card App.tsx should render right
 * now. This is the piece that was missing: App.tsx previously only ever
 * looked for DOOR cards in the raw queue, so MESSAGE/WEEK/DAY (all
 * DEFERRED) never rendered on a real device no matter how long the
 * resident sat on the home screen.
 *
 * App.tsx now attaches a real player (VideoPlayer + KeplerVideoView) behind
 * the SP1_SPIKE_CONTENT_URL flag, so `setPlayback` can receive real
 * snapshots. What is still open is SP-1 itself: whether a card composited
 * on top of Wick's *own* active playback is actually visible and legible on
 * real hardware — an unresolved spike (FRICTION.md's Open Slots,
 * docs/WICK-TECHNICAL.md §14) that needs real Vega hardware to answer, not
 * a code question. Until that spike is run, treat `playback`-driven states
 * (IN_SCENE, NEAR_BREAK, AT_BREAK while playing) as unverified in practice
 * even though the state machine itself is fully tested
 * (NaturalBreakEngine.test.ts) and now fed by a real, wired player.
 *
 * Stateful by necessity — PAUSE_IS_BREAK_MS needs "how long has it been
 * paused", which no single snapshot carries — but the state machine itself
 * (classify/selectReleasable) stays exactly as tested in
 * NaturalBreakEngine.test.ts. `now` is always passed in, never read from a
 * clock here, for the same testability reason that engine has.
 */
import type { QueuedCard } from '@wick/contracts';
import type { PlayerSnapshot } from '../player/PlayerService.js';
import { classify, selectReleasable } from './NaturalBreakEngine.js';
import type { BreakState, EngineInput } from './types.js';

export class BreakController {
  #foregroundSinceMs: number | undefined;
  #pausedSinceMs: number | undefined;
  #lastPlayback: PlayerSnapshot | undefined;

  setForeground(foreground: boolean, now: number): void {
    if (foreground) {
      if (this.#foregroundSinceMs === undefined) this.#foregroundSinceMs = now;
    } else {
      this.#foregroundSinceMs = undefined;
      this.#pausedSinceMs = undefined;
      this.#lastPlayback = undefined;
    }
  }

  setPlayback(snapshot: PlayerSnapshot | undefined, now: number): void {
    if (snapshot?.state === 'PAUSED') {
      if (this.#lastPlayback?.state !== 'PAUSED') this.#pausedSinceMs = now;
    } else {
      this.#pausedSinceMs = undefined;
    }
    this.#lastPlayback = snapshot;
  }

  #engineInput(now: number): EngineInput {
    const appForeground = this.#foregroundSinceMs !== undefined;
    return {
      appForeground,
      now,
      ...(appForeground ? { foregroundForMs: now - this.#foregroundSinceMs! } : {}),
      ...(this.#lastPlayback
        ? {
            playback: {
              state: this.#lastPlayback.state,
              positionMs: this.#lastPlayback.positionMs,
              durationMs: this.#lastPlayback.durationMs,
              ...(this.#lastPlayback.creditsPositionMs !== undefined
                ? { creditsPositionMs: this.#lastPlayback.creditsPositionMs }
                : {}),
            },
          }
        : {}),
      ...(this.#pausedSinceMs !== undefined ? { pausedForMs: now - this.#pausedSinceMs } : {}),
    };
  }

  breakState(now: number): BreakState {
    return classify(this.#engineInput(now));
  }

  /**
   * The single card to show right now, if any. DOOR always wins when
   * releasable (Rule 1 — it renders regardless of state); among releasable
   * DEFERRED cards, the longest-waiting one goes first, so a card queued
   * during one episode is not perpetually skipped by a newer one arriving
   * at the next break.
   */
  pickCard(queue: readonly QueuedCard[], now: number): QueuedCard | undefined {
    const state = this.breakState(now);
    const { release } = selectReleasable(queue, state, now);
    const door = release.find((q) => q.urgency === 'DOOR');
    if (door) return door;

    const deferred = release.filter((q) => q.urgency !== 'DOOR');
    return [...deferred].sort((a, b) => a.queuedAt - b.queuedAt)[0];
  }
}
