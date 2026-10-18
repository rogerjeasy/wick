/**
 * The Natural-Break Engine — S2, the product's defining behaviour.
 *
 * Every competitor interrupts, and every competitor gets muted. The entire
 * emotional difference between "a helpful presence" and "another thing nagging
 * me" lives in this file.
 *
 * Entirely deterministic. No model, no network, no clock of its own — `now` is
 * always passed in, which is what makes the property tests possible.
 *
 * INV-5: a DEFERRED card never renders during IN_SCENE. There are exactly two
 * urgency classes; do not add a third.
 *
 * See docs/WICK-TECHNICAL.md §3.4, docs/WICK.md §7 (Principles 2, 5, 8, 9).
 */
import { DOOR_CARD_TTL_MS, MAX_CARD_SHOWS, type QueuedCard } from '@wick/contracts';
import {
  CALM_POINT_WINDOW_MS,
  NEAR_BREAK_WINDOW_MS,
  PAUSE_IS_BREAK_MS,
  SETTLED_AFTER_MS,
  type BreakState,
  type EngineInput,
  type PlaybackSnapshot,
} from './types.js';

/** Inside the few seconds after one of the programme's calm points. */
function atCalmPoint(pb: PlaybackSnapshot): boolean {
  return pb.calmPointsMs?.some((at) => pb.positionMs >= at && pb.positionMs < at + CALM_POINT_WINDOW_MS) ?? false;
}

export function classify(input: EngineInput): BreakState {
  if (!input.appForeground) return 'IDLE';

  const pb = input.playback;
  if (!pb || pb.state === 'STOPPED') {
    return (input.foregroundForMs ?? 0) >= SETTLED_AFTER_MS ? 'TV_SETTLED' : 'IDLE';
  }

  // A calm point is a break whether the programme is running through it or
  // held on it: a card shown there stops the film (holdsProgramme), and must
  // not vanish again because the film has just stopped.
  if (atCalmPoint(pb)) return 'AT_BREAK';

  if (pb.state === 'PAUSED') {
    return (input.pausedForMs ?? 0) > PAUSE_IS_BREAK_MS ? 'AT_BREAK' : 'IN_SCENE';
  }

  // PLAYING or BUFFERING.
  const credits = pb.creditsPositionMs;
  if (credits !== undefined) {
    if (pb.positionMs >= credits) return 'AT_BREAK';
    if (pb.positionMs >= credits - NEAR_BREAK_WINDOW_MS) return 'NEAR_BREAK';
    return 'IN_SCENE';
  }

  // No credits marker: fall back to the end of the asset.
  if (pb.durationMs > 0 && pb.positionMs >= pb.durationMs) return 'AT_BREAK';
  return 'IN_SCENE';
}

/**
 * Whether the programme should wait while this card is on screen.
 *
 * At the credits a note costs nothing: the story is over, and the film runs
 * on under it. In the middle of a programme — a calm point, or a pause the
 * resident made — reading a note while the story goes on is exactly the
 * interruption Wick exists to avoid. So the film is held on the cut and
 * goes on when the card has gone (watch/WatchScreen.tsx).
 *
 * The door holds it too. The door is the one card that may come in the
 * middle of a scene, and it is the one most likely to make her get up: a
 * film that plays on while she is at the door is a film she has missed. It
 * goes on when she puts the card away herself; a door card that goes by
 * itself while she is out of the room leaves the film where she left it
 * (WatchScreen.tsx `putAwayByHer`).
 */
export function holdsProgramme(card: QueuedCard | undefined, playback: PlaybackSnapshot | undefined): boolean {
  if (!card) return false;
  if (!playback || playback.state === 'STOPPED') return false;
  return playback.positionMs < (playback.creditsPositionMs ?? playback.durationMs);
}

/** The only states in which a DEFERRED card may be shown. */
export function allowsDeferred(state: BreakState): boolean {
  return state === 'AT_BREAK' || state === 'TV_SETTLED';
}

export interface ReleaseResult {
  readonly release: readonly QueuedCard[];
  readonly hold: readonly QueuedCard[];
  /** Shown twice already — drops to a passive home-screen row, never a third card. */
  readonly retire: readonly QueuedCard[];
}

/**
 * Decide what may be shown right now.
 *
 * Rules, verbatim from the technical document:
 *   1. DOOR renders immediately regardless of state.
 *   2. DEFERRED renders only in AT_BREAK or TV_SETTLED.
 *   3. A DEFERRED card ignored once returns at the next break, once. After the
 *      second showing it retires. It never returns a third time.
 *   4. DEFERRED cards never expire — Principle 9, no time limits.
 */
export function selectReleasable(
  queue: readonly QueuedCard[],
  state: BreakState,
  now: number,
): ReleaseResult {
  const release: QueuedCard[] = [];
  const hold: QueuedCard[] = [];
  const retire: QueuedCard[] = [];

  for (const q of queue) {
    if (q.shownCount >= MAX_CARD_SHOWS) {
      retire.push(q);
      continue;
    }

    if (q.urgency === 'DOOR') {
      // Rule 1. Door cards are the only immediate class, and the only class
      // that expires — a stale "someone is at the door" is worse than silence.
      // Cards sent before the Door agent stamped expiresAt fall back to
      // queuedAt + DOOR_CARD_TTL_MS, or a replayed one would never retire.
      if (now >= (q.expiresAt ?? q.queuedAt + DOOR_CARD_TTL_MS)) retire.push(q);
      else release.push(q);
      continue;
    }

    // Rule 2 + INV-5.
    if (allowsDeferred(state)) release.push(q);
    else hold.push(q);
  }

  return { release, hold, retire };
}
