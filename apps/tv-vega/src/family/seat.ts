/**
 * The seat beside her film (packages/contracts/src/familyTelevision.ts
 * `FamilyTvSeat`): what a family member's television shows while it is sat
 * at a film the resident is watching, and how its player keeps up with
 * hers. Pure: family/FamilySeat.tsx draws what this says and does what
 * `follow` tells its player.
 *
 * The television follows and never leads. It has no pause, no skip and no
 * seek of its own: nobody reaches her remote. And it tells nobody anything
 * — nothing here, and nothing that uses it, reports where this player is.
 *
 * The rule is the family app's own (apps/sim-alexa/surface.js `follow`,
 * main.js `keepUp`), kept the same so a film looks the same from a browser
 * and from a television.
 */
import type { CardAction, FamilyTvSeat } from '@wick/contracts';
import type { SeatAnswer } from './familyClient.js';

/** Further than this from where her film is, and this television jumps to it. About two seconds: less, and it would jump at every hiccup. */
export const FOLLOW_DRIFT_MS = 2500;
/** A picture that is not moving is held to within this of hers. */
const FOLLOW_STILL_MS = 500;
/** A jump while playing aims this far ahead: about what it takes to start again, so it lands level and not behind. */
export const SEEK_LEAD_MS = 1000;
/** After a jump the player is left to get there for this long before it is sent anywhere else. */
export const SEEK_SETTLE_MS = 8000;

/** What this television's player should do now. Empty: nothing. */
export interface FollowStep {
  /** Jump to here. */
  readonly seekToMs?: number;
  readonly run?: 'play' | 'pause';
}

/**
 * Where this television's player should be, given where hers is.
 *
 * @param playback  from the server: where her film was, and how long before its answer
 * @param when      when that answer arrived here, and what time it is now — both on this television's clock, so only the difference counts
 * @param local     this television's own player
 */
export function follow(
  playback: FamilyTvSeat['playback'] | undefined,
  when: { readonly arrivedAt: number; readonly now: number },
  local: { readonly positionMs: number; readonly playing: boolean },
  durationMs = 0,
): FollowStep {
  // Stopped, or no word of it: this picture stops where it is.
  if (!playback || playback.state === 'STOPPED') return local.playing ? { run: 'pause' } : {};

  const playing = playback.state === 'PLAYING';
  // A film that is moving has moved on since her television said where it was.
  const moved = playing ? playback.ageMs + Math.max(0, when.now - when.arrivedAt) : 0;
  const target = durationMs > 0 ? Math.min(playback.positionMs + moved, durationMs) : playback.positionMs + moved;
  const off = Math.abs(local.positionMs - target);
  const jump = off > (playing ? FOLLOW_DRIFT_MS : FOLLOW_STILL_MS);
  const lead = playing ? SEEK_LEAD_MS : 0;
  return {
    ...(jump ? { seekToMs: durationMs > 0 ? Math.min(target + lead, durationMs) : target + lead } : {}),
    ...(playing !== local.playing ? { run: playing ? ('play' as const) : ('pause' as const) } : {}),
  };
}

/** The media element's readiness: it knows the film's length; it has picture enough to go on playing. */
const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

/**
 * Whether the player may be sent somewhere now. Not before it knows the
 * film, and not while it is still finding the last place it was sent: a
 * new place at every look would be no place at all.
 */
export function maySeek(player: { readonly readyState: number }, lastSeekAt: number | undefined, now: number): boolean {
  if (player.readyState < HAVE_METADATA) return false;
  const settling = player.readyState < HAVE_FUTURE_DATA && lastSeekAt !== undefined && now - lastSeekAt < SEEK_SETTLE_MS;
  return !settling;
}

/** The television's own words for a seat the server no longer has. */
export const FILM_OVER = 'The film is over.';

export type SeatView =
  /** No answer yet: nothing, rather than a spinner. */
  | { readonly kind: 'opening' }
  /** Sat down: her film, followed — or the sentence that says she has not started it. */
  | { readonly kind: 'sitting'; readonly seat: FamilyTvSeat }
  /** The credits: the film is stopped here, and the one question is asked. */
  | { readonly kind: 'asked'; readonly cardId: string; readonly question: string; readonly answers: readonly CardAction[] }
  /**
   * Ended: the server's last sentence, and one button back to the home
   * screen. The sentence can still change — once this member has answered
   * it says what each said, and hers when it comes — so it goes on being
   * asked for and redrawn. Nothing is composed here from the answers.
   */
  | { readonly kind: 'over'; readonly line: string };

/**
 * What the seat shows after an answer from `GET /tv/seat`. An ask that
 * failed changes nothing; "not allowed" and "signed out" are not the
 * seat's to show (FamilyApp.tsx hands them to the home screen). The very
 * same view comes back when nothing has changed.
 */
export function seatView(previous: SeatView, answer: SeatAnswer): SeatView {
  if (answer.kind !== 'seat') return previous;
  const next = viewOf(answer.seat);
  return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
}

function viewOf(seat: FamilyTvSeat | undefined): SeatView {
  // No seat any more: the invitation's window has closed. The television's own words, and the way back.
  if (!seat) return { kind: 'over', line: FILM_OVER };
  if (seat.state === 'over') return { kind: 'over', line: seat.line };
  if (seat.state === 'asked') {
    return seat.question && seat.answers && seat.answers.length > 0
      ? { kind: 'asked', cardId: seat.cardId, question: seat.question, answers: seat.answers }
      : { kind: 'over', line: seat.line };
  }
  return { kind: 'sitting', seat };
}

/**
 * The name of what there is to press in the seat, for the guard that keeps
 * a press from landing on something that has only just appeared
 * (presses.ts): nothing while the film is on, the question at the credits
 * (by its answers), the last sentence (the same however its words change),
 * or what was said of an answer.
 */
export function seatSurface(view: SeatView, said: string | undefined, answering: boolean): string {
  if (said) return `said:${said}`;
  if (view.kind === 'asked') return answering ? 'answering' : `asked:${view.answers.map((answer) => answer.id).join(',')}`;
  return view.kind;
}

/**
 * Whether the seat asks again after this answer. It does at every state of
 * a seat, `over` included. It stops when there is no seat any more, and
 * when this television may not sit here (FamilyApp.tsx then leaves it).
 */
export function asksAgain(answer: SeatAnswer): boolean {
  if (answer.kind === 'failed') return true;
  return answer.kind === 'seat' && answer.seat !== undefined;
}

/**
 * The server's sentence, shown over the picture — except while her film is
 * playing, when the picture is left alone. It comes and goes with what her
 * television is doing, never with a clock.
 */
export function seatNotice(seat: FamilyTvSeat): string | undefined {
  return seat.state === 'watching' && seat.playback?.state === 'PLAYING' ? undefined : seat.line;
}
