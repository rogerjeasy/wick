/**
 * Watch together, on the television: what her player says about the film,
 * to the one person she is watching it with.
 *
 * This is the first half of the rule in packages/contracts/src/watch.ts. A
 * reporter exists only after her press on "Start the film" (App.tsx), is
 * made for the one film that card named, and says nothing about any other
 * — and nothing at all once she has left the film, or the session's time
 * is up. Leaving is final: the press was for that showing of the film, and
 * the same film chosen again from the home screen is hers alone. The edge keeps the
 * same rule again on its side (services/edge-device/lambda/
 * watch-together.mjs); neither trusts the other.
 *
 * It is not chatty. The player gives a snapshot a second; what is worth
 * sending is a change she made — play, pause, a skip — and, while the film
 * plays, a word every few seconds so the other player can tell a television
 * that is playing from one that has gone.
 *
 * Pure: `now` is passed in, and what comes back is the event to send, or
 * nothing.
 */
import { WATCH_HEARTBEAT_MS, type DeviceEvent, type PlaybackStateName } from '@wick/contracts';
import type { PlayerSnapshot } from '../player/PlayerService.js';

/** The session her press on "Start the film" began. */
export interface Together {
  readonly sessionId: string;
  readonly programmeId: string;
  /** Who is watching along, as the resident knows them. */
  readonly withName: string;
  /** After this, nobody is following, and nothing is sent. */
  readonly until: number;
}

export type WatchPosition = Extract<DeviceEvent, { readonly t: 'watch_position' }>;

/** Further from where the film should be than this, and she skipped. A seek on the VVD lands within a second. */
const SKIP_MS = 2_000;

export class TogetherReporter {
  readonly #session: Together;
  #last: { readonly state: PlaybackStateName; readonly positionMs: number; readonly at: number } | undefined;
  /** She left the film. Nothing after this is said, whatever plays. */
  #left = false;

  constructor(session: Together) {
    this.#session = session;
  }

  /** `snapshot` undefined: the player has gone — she left the film. */
  report(snapshot: PlayerSnapshot | undefined, now: number): WatchPosition | undefined {
    if (this.#left || now >= this.#session.until) return undefined;
    const last = this.#last;

    if (!snapshot) {
      // Only a film that was on can be left; before that the player is still on its way.
      if (!last) return undefined;
      this.#left = true;
      return last.state === 'STOPPED' ? undefined : this.#say('STOPPED', last.positionMs, now);
    }
    if (snapshot.contentId !== this.#session.programmeId) return undefined;
    if (!last || snapshot.state !== last.state) return this.#say(snapshot.state, snapshot.positionMs, now);

    const expected = last.positionMs + (last.state === 'PLAYING' ? now - last.at : 0);
    if (Math.abs(snapshot.positionMs - expected) > SKIP_MS) return this.#say(snapshot.state, snapshot.positionMs, now);
    // The credits are where each of them is asked the one question: said as they begin, not at the next check-in.
    const credits = snapshot.creditsPositionMs;
    if (credits !== undefined && last.positionMs < credits && snapshot.positionMs >= credits) return this.#say(snapshot.state, snapshot.positionMs, now);
    if (snapshot.state === 'PLAYING' && now - last.at >= WATCH_HEARTBEAT_MS) return this.#say(snapshot.state, snapshot.positionMs, now);
    return undefined;
  }

  #say(state: PlaybackStateName, positionMs: number, now: number): WatchPosition {
    this.#last = { state, positionMs, at: now };
    return { t: 'watch_position', sessionId: this.#session.sessionId, state, positionMs, contentId: this.#session.programmeId, at: now };
  }
}
