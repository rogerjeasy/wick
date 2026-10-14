/**
 * What the platform's media controls do to her film.
 *
 * Vega delivers "Alexa, pause", "Alexa, resume", "Alexa, start over",
 * "Alexa, rewind thirty seconds" and the system's own transport controls to
 * the app on screen as commands of its media session (Vega Media Controls,
 * `@amazon-devices/kepler-media-controls`). watch/mediaControls.ts is the
 * thin part that registers for them; this file decides what each one does,
 * and is pure so it is tested without a television.
 *
 * A command is her press, by another way. It obeys every rule her remote
 * keys obey (remoteKeys.ts), and nothing it does is new:
 *
 * - **Pause is a pause.** The film stops, the Natural-Break Engine sees a
 *   pause like any other, and after a few seconds a note that was waiting
 *   comes on screen over it and holds the film on the cut
 *   (break/NaturalBreakEngine.ts) — exactly as when she pressed the key.
 *   Over a note that is already holding the film, "pause" means she wants
 *   it to stay paused when the note has gone, as it does when she paused
 *   first herself.
 * - **Play names the film.** "Alexa, play" carries on with the film — over
 *   a note that holds it too, which is what her second Play there does: the
 *   film goes on and the note is put away. It never asks for the card to
 *   be read: Read to me (packages/contracts/src/speech.ts) is a key, and a
 *   small mark on the card that says which key; nothing on her screen says
 *   that saying "play" would read a card aloud, and Wick never reads one she
 *   did not ask to have read. A reading under way ends, as it does when
 *   Play carries on with the film.
 * - **Play/Pause, as one command, is the key.** The platform sends it for
 *   the remote's own Play/Pause button where it routes that button through
 *   the media session; then it means exactly what the key means — on a card
 *   that can be read, the first one reads (remoteKeys.ts playIsTheCards).
 * - **Stop is a pause.** Wick's films have no stop: a film she stopped
 *   would be one she has to find her place in again. She leaves a film with
 *   Back.
 * - **Start over** goes back to the first frame and plays; **skip** moves
 *   as the skip keys do, by the step the platform asks for (thirty seconds
 *   when it names none), never past the last second.
 * - **Nothing while the door camera is open.** That screen has the remote
 *   (live/LiveView.tsx), and the film is held behind it.
 * - **One press is one press.** On the Vega Virtual Device the remote's
 *   Play/Pause button reaches the app twice: as the key, and some 60 ms
 *   later as the session's Play/Pause command (FRICTION.md FL-030). Acted
 *   on both ways, a press would pause the film and play it again at once. So
 *   the key goes first, as it always did, and a command that echoes a media
 *   key pressed within a moment of it is let go (`keyEchoes`) — waiting that
 *   moment first, in case the command is the one that arrives first.
 *
 * Next and Previous are refused, as are fast-forward, rewind, speeds,
 * tracks, ratings and anything else: there is no playlist, one speed, and
 * nothing to choose. The manifest offers the platform only what is here
 * (manifest.toml, `IMediaPlaybackServer`).
 *
 * And it is hers alone. A family member's own television plays the same
 * film beside her (family/FamilySeat.tsx) with no pause and no skip: that
 * seat answers every command with a refusal (media/refusal.ts), so no
 * voice and no remote in Sarah's room reaches her film or Sarah's copy of it.
 */
import { SEEK_STEP_MS, playGoesTo, seekTarget, type KeyContext, type ReadCommand } from './remoteKeys.js';

/** The commands Wick's film obeys. Everything else the platform could send is refused. */
export type MediaCommand = 'play' | 'pause' | 'toggle' | 'stop' | 'startOver' | 'skipForward' | 'skipBackward';

/** The optional commands the manifest asks the platform for. Play, Pause, Play/Pause and Stop are the platform's core: always delivered. */
export const MANIFEST_COMMAND_OPTIONS: readonly string[] = ['StartOver', 'SkipForward', 'SkipBackward'];

/** What the app knows when a command arrives: what a key is told, and the two things only the film's screen knows. */
export interface MediaContext extends KeyContext {
  /** A note is holding the film on the cut (NaturalBreakEngine.holdsProgramme). */
  readonly held: boolean;
  /** The door camera has the screen. */
  readonly suspended: boolean;
}

/** Where the film is when the command arrives. */
export interface FilmNow {
  readonly paused: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
}

/** What to do to the film. `pause` is hers: a film a note was holding stays paused after the note. */
export type FilmMove =
  | { readonly kind: 'play' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'seek'; readonly toMs: number; readonly thenPlay: boolean };

export interface MediaOutcome {
  readonly film?: FilmMove;
  readonly reader?: ReadCommand;
}

const NOTHING: MediaOutcome = {};

export function mediaOutcome(command: MediaCommand, context: MediaContext, film: FilmNow, deltaMs?: number): MediaOutcome {
  if (context.suspended) return NOTHING;
  const reading = context.reading === true;
  // Carrying on with the film, or moving it, ends a reading under way over a card — as Play does when it is the film's.
  const endReading: ReadCommand | undefined = context.cardVisible && reading ? 'stop' : undefined;
  const withReader = (outcome: { readonly film?: FilmMove }, reader: ReadCommand | undefined): MediaOutcome =>
    reader ? { ...outcome, reader } : outcome;

  switch (command) {
    case 'toggle': {
      // The remote's own button, by the media session: exactly the key.
      const goes = playGoesTo('playpause', context);
      return withReader(goes.film ? { film: { kind: 'toggle' } } : {}, goes.reader);
    }
    case 'play':
      return withReader(film.paused ? { film: { kind: 'play' } } : {}, endReading);
    case 'pause':
    case 'stop':
      // Silence is what "pause" asks for: a reading under way ends too.
      return withReader(film.paused && !context.held ? {} : { film: { kind: 'pause' } }, reading ? 'stop' : undefined);
    case 'startOver':
      return withReader({ film: { kind: 'seek', toMs: 0, thenPlay: true } }, endReading);
    case 'skipForward':
    case 'skipBackward': {
      const step = deltaMs !== undefined && Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : SEEK_STEP_MS;
      const toMs = seekTarget(film.positionMs, command === 'skipForward' ? 'forward' : 'back', film.durationMs, step);
      return withReader({ film: { kind: 'seek', toMs, thenPlay: false } }, endReading);
    }
  }
}

/** The player, as much of it as a command moves. */
export interface MovablePlayer {
  readonly paused: boolean;
  currentTime: number;
  play(): unknown;
  pause(): unknown;
}

/**
 * Do it, to the one player her keys move too (watch/WatchScreen.tsx).
 * `herPause` is told when the move is her pause: a film a note is holding
 * then stays paused when the note has gone.
 */
export function moveFilm(player: MovablePlayer, move: FilmMove, herPause: () => void): void {
  switch (move.kind) {
    case 'toggle':
      if (player.paused) void player.play();
      else player.pause();
      return;
    case 'play':
      void player.play();
      return;
    case 'pause':
      herPause();
      if (!player.paused) player.pause();
      return;
    case 'seek':
      player.currentTime = move.toMs / 1000;
      if (move.thenPlay && player.paused) void player.play();
      return;
  }
}

/** Which of the remote's media buttons a key event, or a command, is. */
type MediaButton = 'playpause' | 'forward' | 'back';

/** Every name the remote's media keys arrive under (remoteKeys.ts, FRICTION.md FL-021). */
const KEY_BUTTON: Readonly<Record<string, MediaButton>> = {
  playpause: 'playpause',
  play: 'playpause',
  pause: 'playpause',
  skip_forward: 'forward',
  forward: 'forward',
  fast_forward: 'forward',
  skip_backward: 'back',
  rewind: 'back',
};

/** The button a command would be the echo of. Start over has no button of its own. */
const COMMAND_BUTTON: Readonly<Record<MediaCommand, MediaButton | undefined>> = {
  toggle: 'playpause',
  play: 'playpause',
  pause: 'playpause',
  stop: 'playpause',
  startOver: undefined,
  skipForward: 'forward',
  skipBackward: 'back',
};

/** How far apart a key and its echo may arrive. Seen: about 60 ms. */
export const ECHO_WINDOW_MS = 600;
/** How long a command waits for the key it may be the echo of. A voice command is late by this much, and no more. */
export const ECHO_WAIT_MS = 300;

export interface KeyEchoes {
  /** A key went down. */
  key(eventType: string, at: number): void;
  /** Whether a command that arrived at `at` is a media key's own press, heard a second way. */
  echoes(command: MediaCommand, at: number): boolean;
}

export function keyEchoes(windowMs: number = ECHO_WINDOW_MS): KeyEchoes {
  const pressed = new Map<MediaButton, number>();
  return {
    key(eventType, at) {
      const button = Object.prototype.hasOwnProperty.call(KEY_BUTTON, eventType) ? KEY_BUTTON[eventType] : undefined;
      if (button) pressed.set(button, at);
    },
    echoes(command, at) {
      const button = COMMAND_BUTTON[command];
      const keyAt = button ? pressed.get(button) : undefined;
      return keyAt !== undefined && Math.abs(at - keyAt) <= windowMs;
    },
  };
}

/** The platform's time value. */
export interface TimeValue {
  readonly seconds: number;
  readonly nanoseconds: number;
}

export const toTimeValue = (ms: number): TimeValue => {
  const whole = Math.max(0, Math.floor(ms));
  return { seconds: Math.floor(whole / 1000), nanoseconds: (whole % 1000) * 1_000_000 };
};

export const fromTimeValue = (t: TimeValue | undefined): number | undefined =>
  t && Number.isFinite(t.seconds) ? t.seconds * 1000 + Math.round((t.nanoseconds ?? 0) / 1_000_000) : undefined;

/** The session's playback status, by the platform's names. */
export type SessionStatus = 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'NOT_PLAYING';

/** The platform's action names this session offers, given how the film stands. */
export type SessionAction = 'PLAY' | 'PAUSE' | 'TOGGLE_PLAY_PAUSE' | 'STOP' | 'START_OVER' | 'SKIP_FORWARD' | 'SKIP_BACKWARD';

/** A snapshot of the film, as PlayerService gives it. */
export interface SessionSnapshot {
  readonly state: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'STOPPED';
  readonly positionMs: number;
  readonly durationMs: number;
  readonly contentId: string;
}

/** Everything the session tells the platform, in plain values; watch/mediaControls.ts turns it into the platform's types. */
export interface SessionView {
  readonly status: SessionStatus;
  readonly speed: number;
  readonly positionMs: number;
  readonly updatedAtMs: number;
  readonly durationMs: number;
  readonly contentId: string;
  readonly actions: readonly SessionAction[];
  readonly skipStepMs: number;
}

export function sessionView(snapshot: SessionSnapshot, now: number): SessionView {
  const status: SessionStatus = snapshot.state === 'STOPPED' ? 'NOT_PLAYING' : snapshot.state;
  // Offered now: Play when it is paused, Pause when it is not — and what is always hers.
  const actions: SessionAction[] = [
    status === 'PAUSED' || status === 'NOT_PLAYING' ? 'PLAY' : 'PAUSE',
    'TOGGLE_PLAY_PAUSE',
    'STOP',
    'START_OVER',
    'SKIP_FORWARD',
    'SKIP_BACKWARD',
  ];
  return {
    status,
    speed: status === 'PLAYING' ? 1 : 0,
    positionMs: snapshot.positionMs,
    updatedAtMs: now,
    durationMs: snapshot.durationMs,
    contentId: snapshot.contentId,
    actions,
    skipStepMs: SEEK_STEP_MS,
  };
}

/** How far the film may drift from where the last word put it before the platform is told again. */
const DRIFT_MS = 2_000;

/**
 * Whether the platform needs telling. The player reports once a second; the
 * platform is told when the state changes, when another film is in, and
 * when the film is not where the last word, run on at its speed, would
 * have it — a seek, or a stall — not on every tick.
 */
export function shouldPublish(last: SessionView | undefined, next: SessionView): boolean {
  if (!last) return true;
  if (last.status !== next.status || last.contentId !== next.contentId || last.durationMs !== next.durationMs) return true;
  const expected = last.positionMs + (next.updatedAtMs - last.updatedAtMs) * last.speed;
  return Math.abs(next.positionMs - expected) > DRIFT_MS;
}

/** What the platform is told about the film: its name and the line that credits it, as her screen shows them. */
export interface SessionMetadata {
  readonly title: string;
  readonly description: string;
  readonly mediaType: 'video';
}

export const sessionMetadata = (programme: { readonly title: string; readonly attribution: string }): SessionMetadata => ({
  title: programme.title,
  description: programme.attribution,
  mediaType: 'video',
});

export { REFUSED_COMMANDS, Refused, refusesEverything, type RefusingHandler } from '../media/refusal.js';
