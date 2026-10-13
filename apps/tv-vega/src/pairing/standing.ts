/**
 * Whether this television is still connected to a home — asked of the
 * pairing service while the television is in use, because nothing else
 * tells it. Pure: App.tsx and the card service give it the asking.
 *
 * Seen on the Fire OS emulator, 2026-10-13: the organiser disconnected the
 * resident's television from the family app, and it went on showing her
 * home screen — for as long as anyone watched, and again after a relaunch.
 * A token on disk that has not run out is used without asking anybody
 * (PairingFlow.loadToken), as it always was; the edge refuses that
 * television everything from then on — a new connection, every message on
 * an old one — but a refusal on the card channel looks to the television
 * exactly like a network that has gone, and it kept trying for ever.
 *
 * So it asks. `POST /pair/refresh` answers for a television by its id
 * (edge-device pair-refresh.mjs), and three of its answers are definite:
 *
 *   - 404 `device_not_paired`  — no home holds this television: disconnected.
 *   - 403 `device_denylisted`  — revoked.
 *   - 401                      — a family member's television whose token
 *                                is not its own (never the resident's).
 *
 * On any of those the television is no longer connected (`onGone`): it
 * forgets its token, what it remembers of the home, and shows the pairing
 * screen. A token handed back means it is connected. EVERYTHING ELSE —
 * asked too soon (429), the service in trouble (5xx), no answer in ten
 * seconds, no network — is nothing known, and changes nothing: a television
 * must never drop to the pairing screen for a network that is only slow,
 * or gone. It carries on, and asks again.
 *
 * When it asks:
 *   - as soon as it is on screen — at launch, and on the way back from
 *     another app — unless the pairing service has only just answered for
 *     it (a television that keeps no token asks for one at every launch,
 *     and is told then);
 *   - every STANDING_EVERY_MS while it is on screen;
 *   - at once when its card channel is in trouble — a connection refused,
 *     or one that was open and is not: that is what a disconnection looks
 *     like from here, as well as what a lost network does.
 * Never more than once in STANDING_MIN_GAP_MS, never two at once, and not
 * at all while it is off the screen.
 *
 * THE FRESH TOKEN. Every "connected" comes with a token good for an hour —
 * that is how the pairing service says it. The watch used to throw it away,
 * and a television whose own token then ran out (an hour after launch on
 * the Vega simulator, which keeps none on disk; thirty days after pairing
 * on Fire OS) was cut off its channel and refused every reconnection until
 * Wick was launched again. Now the token in the answer is taken (`onFresh`)
 * when the one in use has run out or is about to (held.ts, five minutes):
 *
 *   - from the routine ask, before anything is cut: the channel is started
 *     again with the fresh token while the old one still opens it;
 *   - from the ask its trouble prompts, when the routine one could not be
 *     answered in time — or where there is no routine one (the card
 *     service).
 *
 * "Connected" while the token in use has plenty of life left changes
 * nothing, as before. With one exception, which does not rest on any clock:
 * trouble that GOES ON after the pairing service has said "connected". The
 * network is there, the television belongs to its home, and the channel
 * still will not open — then the next "connected" brings its token into use
 * whatever age the old one seems to be. Without it a television whose clock
 * was put right while it ran, or whose token cannot be read, would be back
 * to waiting for a relaunch.
 *
 * Nothing more is asked for any of this: the question was being asked
 * already, and each answer already minted a token.
 *
 * A token for another home, or one naming another kind of television, is
 * never taken: this television is then no longer connected to the home it
 * shows, and that is what it is told.
 */
import type { DeviceToken } from '@wick/contracts';
import type { RenewResult } from './PairingFlow.js';
import { nearItsEnd, type HeldToken } from './held.js';

/** How often a television on screen asks whether it is still connected. A disconnected one shows the pairing screen within this, at the latest. */
export const STANDING_EVERY_MS = 60_000;
/** The least time between two asks, whatever prompts them: the pairing service lets a television ask four times in half a minute, and its launch needs two of them. */
export const STANDING_MIN_GAP_MS = 30_000;
/**
 * A channel that has said nothing of trouble for this long is out of it.
 * Longer than its slowest retry (transport/startCardChannel.ts: thirty
 * seconds, and the connection's own few), so one trouble is not taken for two.
 */
export const TROUBLE_QUIET_MS = 60_000;
/** A channel that is not open says so once a second (startCardChannel.ts): trouble heard this lately is trouble now. */
const TROUBLE_NOW_MS = 2_000;

export type Standing = 'connected' | 'not_connected' | 'unknown';

/** What an answer from the pairing service says of this television (PairingFlow.renew). */
export function standingOf(answer: RenewResult): Standing {
  if (answer === 'not_connected') return 'not_connected';
  return answer === 'try_later' ? 'unknown' : 'connected';
}

/** Whether a token the pairing service handed back is for the television that asked: the same one, in the same home, of the same kind. */
function forThisTelevision(fresh: DeviceToken, held: DeviceToken): boolean {
  return fresh.deviceId === held.deviceId && fresh.householdId === held.householdId && fresh.kind === held.kind;
}

export interface StandingWatch {
  /** Whether Wick is the app on screen. */
  onScreen(onScreen: boolean): void;
  /** The card channel was refused, or is not open. */
  trouble(): void;
  stop(): void;
}

export function standingWatch(deps: {
  /** Puts the question to the pairing service, showing the token in use (PairingFlow.renew — and nothing written down for the asking). */
  readonly ask: (held: DeviceToken) => Promise<RenewResult>;
  /** The pairing service says this television is no longer connected. Called once. */
  readonly onGone: () => void;
  /**
   * The token the channel was opened with — and, when the pairing service
   * has only just handed it over, when that was: it has then just answered
   * for this television, and is not asked again at once.
   */
  readonly held: HeldToken;
  /** A fresh token to use in place of the one held: open the channel again with it. */
  readonly onFresh: (token: DeviceToken) => void;
}): StandingWatch {
  let held = deps.held;
  let lastAskedAt = held.since ?? Number.NEGATIVE_INFINITY;
  let lastTroubleAt = Number.NEGATIVE_INFINITY;
  /** The pairing service has said "connected" during the trouble the channel is in, and the trouble has gone on. */
  let connectedInTrouble = false;
  let out = false;
  let over = false;
  let watching = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const rest = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const gone = (): void => {
    over = true;
    rest();
    deps.onGone();
  };

  const ask = (): void => {
    if (over || out) return;
    const now = Date.now();
    if (now - lastAskedAt < STANDING_MIN_GAP_MS) return;
    lastAskedAt = now;
    out = true;
    void (async () => {
      let answer: RenewResult;
      try {
        answer = await deps.ask(held.token);
      } catch {
        answer = 'try_later';
      }
      out = false;
      if (over || answer === 'try_later') return;
      if (answer === 'not_connected' || !forThisTelevision(answer.token, held.token)) return gone();

      const answeredAt = Date.now();
      // In trouble when it asked, or since: not an answer to the routine ask of a channel that is open.
      const troubled = lastTroubleAt >= now - TROUBLE_NOW_MS;
      if (!nearItsEnd(held, answeredAt) && !(troubled && connectedInTrouble)) {
        connectedInTrouble = troubled;
        return;
      }
      connectedInTrouble = false;
      held = { token: answer.token, since: answeredAt };
      deps.onFresh(answer.token);
    })();
  };

  return {
    onScreen(onScreen) {
      if (over || onScreen === watching) return;
      watching = onScreen;
      rest();
      if (!onScreen) return;
      ask();
      timer = setInterval(ask, STANDING_EVERY_MS);
    },
    trouble() {
      const now = Date.now();
      // Quiet for a while: the last trouble ended, and this is another.
      if (now - lastTroubleAt > TROUBLE_QUIET_MS) connectedInTrouble = false;
      lastTroubleAt = now;
      ask();
    },
    stop() {
      over = true;
      rest();
    },
  };
}
