import type { BreakState, PlaybackStateName } from '@wick/contracts';

export interface PlaybackSnapshot {
  readonly state: PlaybackStateName;
  readonly positionMs: number;
  readonly durationMs: number;
  /** The platform's own "episode is ending" marker. See WICK-TECHNICAL.md §3.3. */
  readonly creditsPositionMs?: number;
  /**
   * Calm points: positions inside the programme where the picture changes
   * and nobody is speaking (catalog/calmPoints.ts, measured by
   * scripts/calm-points). A break of a few seconds each, so a note does not
   * have to wait for the credits.
   */
  readonly calmPointsMs?: readonly number[];
}

export interface EngineInput {
  readonly playback?: PlaybackSnapshot;
  readonly appForeground: boolean;
  /** ms since the app came to the foreground; undefined when backgrounded. */
  readonly foregroundForMs?: number;
  /** ms the player has been paused; undefined when not paused. */
  readonly pausedForMs?: number;
  readonly now: number;
}

export type { BreakState };

/**
 * How long a calm point lasts. The player reports its position about once a
 * second, so this is long enough to be noticed and short enough that a card
 * never arrives a scene late.
 */
export const CALM_POINT_WINDOW_MS = 8_000;
/** Approaching credits — prefetch and pre-render, but do not release. */
export const NEAR_BREAK_WINDOW_MS = 30_000;
/** A pause longer than this counts as a break. */
export const PAUSE_IS_BREAK_MS = 5_000;
/** The resident has settled; safe to show a deferred card. */
export const SETTLED_AFTER_MS = 20_000;
