/**
 * Ties PlayerService's snapshots and the app's foreground lifecycle to
 * NaturalBreakEngine, and picks the single card App.tsx should render right
 * now. This is the piece that was missing: App.tsx previously only ever
 * looked for DOOR cards in the raw queue, so MESSAGE/WEEK/DAY (all
 * DEFERRED) never rendered on a real device no matter how long the
 * resident sat on the home screen.
 *
 * watch/WatchScreen.tsx feeds `setPlayback` from Wick's own player, and the
 * playback-driven states are seen working on the Vega Virtual Device: a note
 * sent mid-programme stayed held through IN_SCENE and appeared as the
 * credits began (AT_BREAK), and after a pause of five seconds.
 *
 * Stateful by necessity — PAUSE_IS_BREAK_MS needs "how long has it been
 * paused", which no single snapshot carries — but the state machine itself
 * (classify/selectReleasable) stays exactly as tested in
 * NaturalBreakEngine.test.ts. `now` is always passed in, never read from a
 * clock here, for the same testability reason that engine has.
 */
import type { QueuedCard } from '@wick/contracts';
import type { PlayerSnapshot } from '../player/PlayerService.js';
import { MAX_CARD_SHOWS } from '@wick/contracts';
import { allowsDeferred, classify, holdsProgramme, selectReleasable } from './NaturalBreakEngine.js';
import { CALM_POINT_WINDOW_MS, type BreakState, type EngineInput } from './types.js';

/**
 * What changed on screen since the last look. `began`: a card has just come
 * on screen — the moment to tell the server it was shown. `ended`: a
 * DEFERRED card's showing is over and it was left unanswered — one of the
 * two it gets (NaturalBreakEngine's Rule 3).
 */
export interface Showing {
  readonly began?: QueuedCard;
  readonly ended?: QueuedCard;
}

export interface BreakControllerOptions {
  /**
   * The calm points of a programme, by its id (catalog/calmPoints.ts).
   * Looked up here rather than carried on every snapshot: they are a fact
   * about the programme, not about where the player has got to.
   */
  readonly calmPointsOf?: (contentId: string) => readonly number[] | undefined;
}

export class BreakController {
  readonly #calmPointsOf: NonNullable<BreakControllerOptions['calmPointsOf']>;

  constructor(options: BreakControllerOptions = {}) {
    this.#calmPointsOf = options.calmPointsOf ?? (() => undefined);
  }

  /** The DEFERRED card whose showing is under way. */
  #showingId: string | undefined;
  #lastDoorId: string | undefined;
  #foregroundSinceMs: number | undefined;
  #pausedSinceMs: number | undefined;
  #lastPlayback: PlayerSnapshot | undefined;
  /**
   * The calm point the resident pressed Play on. They chose the film, so a
   * note shown there goes at once instead of staying over the story until
   * the film has run out of the calm point's few seconds.
   */
  #playedOnFromMs: number | undefined;

  setForeground(foreground: boolean, now: number): void {
    if (foreground) {
      if (this.#foregroundSinceMs === undefined) this.#foregroundSinceMs = now;
    } else {
      this.#foregroundSinceMs = undefined;
      this.#pausedSinceMs = undefined;
      this.#lastPlayback = undefined;
      this.#playedOnFromMs = undefined;
    }
  }

  setPlayback(snapshot: PlayerSnapshot | undefined, now: number): void {
    if (snapshot?.state === 'PAUSED') {
      if (this.#lastPlayback?.state !== 'PAUSED') this.#pausedSinceMs = now;
    } else {
      this.#pausedSinceMs = undefined;
    }
    if (snapshot && snapshot.state !== 'PAUSED' && this.#lastPlayback?.state === 'PAUSED') {
      this.#playedOnFromMs = this.#calmPointAt(snapshot);
    } else if (!snapshot || this.#calmPointAt(snapshot) !== this.#playedOnFromMs) {
      // The film has left it: played through again, it is a calm point again.
      this.#playedOnFromMs = undefined;
    }
    this.#lastPlayback = snapshot;
  }

  /** The calm point this snapshot is inside the few seconds of, if any. */
  #calmPointAt(snapshot: PlayerSnapshot): number | undefined {
    return this.#calmPointsOf(snapshot.contentId)?.find(
      (at) => snapshot.positionMs >= at && snapshot.positionMs < at + CALM_POINT_WINDOW_MS,
    );
  }

  /** Where the player is, with what is known about the programme it is playing. */
  #playback(): EngineInput['playback'] {
    const last = this.#lastPlayback;
    if (!last) return undefined;
    const calmPointsMs = this.#calmPointsOf(last.contentId)?.filter((at) => at !== this.#playedOnFromMs);
    return {
      state: last.state,
      positionMs: last.positionMs,
      durationMs: last.durationMs,
      ...(last.creditsPositionMs !== undefined ? { creditsPositionMs: last.creditsPositionMs } : {}),
      ...(calmPointsMs ? { calmPointsMs } : {}),
    };
  }

  /** Whether the programme should wait while this card is on screen (NaturalBreakEngine.holdsProgramme). */
  holdsProgramme(card: QueuedCard | undefined): boolean {
    return holdsProgramme(card, this.#playback());
  }

  #engineInput(now: number): EngineInput {
    const appForeground = this.#foregroundSinceMs !== undefined;
    const playback = this.#playback();
    return {
      appForeground,
      now,
      ...(appForeground ? { foregroundForMs: now - this.#foregroundSinceMs! } : {}),
      ...(playback ? { playback } : {}),
      ...(this.#pausedSinceMs !== undefined ? { pausedForMs: now - this.#pausedSinceMs } : {}),
    };
  }

  breakState(now: number): BreakState {
    return classify(this.#engineInput(now));
  }

  /**
   * The single card to show right now, if any. DOOR always wins when
   * releasable (Rule 1 — it renders regardless of state); among releasable
   * DEFERRED cards, one the resident just asked for (respondsTo) goes
   * first, then the longest-waiting one, so a card queued
   * during one episode is not perpetually skipped by a newer one arriving
   * at the next break.
   */
  pickCard(queue: readonly QueuedCard[], now: number): QueuedCard | undefined {
    const picked = this.#pick(queue, now);
    // The card as the queue holds it, not the copy #underWay may have made.
    return picked && queue.find((q) => q.id === picked.id);
  }

  #pick(queue: readonly QueuedCard[], now: number): QueuedCard | undefined {
    const state = this.breakState(now);
    const { release } = selectReleasable(this.#underWay(queue), state, now);
    // The newest visit: whoever came earlier is no longer at the door.
    const door = release
      .filter((q) => q.urgency === 'DOOR')
      .sort((a, b) => b.card.createdAt - a.card.createdAt)[0];
    if (door) return door;

    const deferred = release.filter((q) => q.urgency !== 'DOOR');
    // A card the resident just asked for answers their press; it goes first.
    const asked = deferred.find((q) => q.respondsTo !== undefined);
    if (asked) return asked;
    return [...deferred].sort((a, b) => a.queuedAt - b.queuedAt)[0];
  }

  /**
   * A card on screen stays on screen until its break ends. The server counts
   * a showing when it begins, so a card replayed during its second showing
   * (a reconnect) already says "shown twice" — which must not take it away
   * from someone who is reading it.
   */
  #underWay(queue: readonly QueuedCard[]): readonly QueuedCard[] {
    if (this.#showingId === undefined) return queue;
    return queue.map((q) =>
      q.id === this.#showingId && q.shownCount >= MAX_CARD_SHOWS ? { ...q, shownCount: MAX_CARD_SHOWS - 1 } : q,
    );
  }

  /**
   * Call once per look, with what pickCard chose. A showing lasts from the
   * moment a DEFERRED card comes on screen until the break it came in is
   * over: the doorbell ringing over it does not end it, and answering it is
   * not ignoring it.
   */
  noteShown(picked: QueuedCard | undefined, queue: readonly QueuedCard[], now: number): Showing {
    let began: QueuedCard | undefined;
    let ended: QueuedCard | undefined;

    if (this.#showingId !== undefined) {
      const showing = queue.find((q) => q.id === this.#showingId);
      if (!showing) {
        this.#showingId = undefined; // answered, or taken back
      } else if (!allowsDeferred(this.breakState(now))) {
        ended = showing;
        this.#showingId = undefined;
      }
    }

    if (picked?.urgency === 'DOOR') {
      if (picked.id !== this.#lastDoorId) {
        began = picked;
        this.#lastDoorId = picked.id;
      }
    } else if (picked && picked.id !== this.#showingId) {
      began = picked;
      this.#showingId = picked.id;
    }

    return { ...(began ? { began } : {}), ...(ended ? { ended } : {}) };
  }

  /**
   * She answered this card: its showing is over, there and then. Without
   * this, a card the server sends back under the same id before the next
   * look — a picture she pressed "Keep it" on, with her mantelpiece full
   * (packages/contracts mantel.ts) — would be taken for the one still on
   * screen: never said to be shown, and counted wrongly when the break ends.
   */
  answered(cardId: string): void {
    if (this.#showingId === cardId) this.#showingId = undefined;
  }

  /**
   * The card that has had its two showings and now waits to be asked for —
   * the longest-waiting one, for the home screen's quiet row. Never a door
   * card: a visitor who has gone is not waiting.
   */
  waiting(queue: readonly QueuedCard[], now: number): QueuedCard | undefined {
    const { retire } = selectReleasable(this.#underWay(queue), this.breakState(now), now);
    return retire.filter((q) => q.urgency !== 'DOOR').sort((a, b) => a.queuedAt - b.queuedAt)[0];
  }
}
