/**
 * Her film as Android's media session, seen from JavaScript: the server the
 * shared source asks Vega Media Controls for, on top of Wick's own Android
 * module (android/.../media/FilmSessionModule.kt).
 *
 * The shared session (apps/tv-vega/src/watch/mediaControls.ts) does what it
 * does on Vega, unchanged: it registers a handler, and publishes where the
 * film is. Here a published state goes to Android's session — made when the
 * first state comes, let go when the state says there is no film — and a
 * command from Android's session (Alexa on a Fire TV, the remote's media
 * keys, the system's transport controls) is given to that handler by the
 * name Vega would have called. So every command passes through the rules
 * her remote's keys obey (watch/mediaSession.ts): a pause is a natural
 * break, nothing moves while the door camera has the screen, a press heard
 * both as a key and as a command counts once, and a family member's seat,
 * whose handler refuses everything, never has a session at all.
 *
 * No React and no native module here, so it is tested as plain code
 * (src/__tests__/filmSession.test.ts).
 */
import type { IMediaControlHandlerAsync, ITimeValue, MediaSessionState } from '../adapters/mediaControls';

/** What Android's session is told: the shared session's state, in plain values. */
export interface NativeFilm {
  readonly status: string;
  readonly positionMs: number;
  readonly speed: number;
  readonly durationMs: number;
  readonly contentId: string;
  readonly title: string;
  readonly description: string;
  /** Vega's action names ("Pause", "SkipForward"…); FilmTransport.kt turns them into Android's. */
  readonly actions: readonly string[];
}

/** A command from Android's session, by the shared rules' names (mediaSession.ts `MediaCommand`). */
export interface NativeCommand {
  readonly command: string;
  readonly deltaMs?: number;
}

export interface FilmSessionNative {
  publish(film: NativeFilm): Promise<void>;
  release(): Promise<void>;
  /** Every command the session is given, until the returned function is called. */
  onCommand(listener: (command: NativeCommand) => void): () => void;
}

/** Which of Vega's handler calls each command is. Anything else from Android is nothing of Wick's. */
export const HANDLER_FOR: Readonly<Record<string, string>> = {
  play: 'handlePlay',
  pause: 'handlePause',
  toggle: 'handleTogglePlayPause',
  stop: 'handleStop',
  startOver: 'handleStartOver',
  skipForward: 'handleSkipForward',
  skipBackward: 'handleSkipBackward',
};

type Call = (...args: unknown[]) => Promise<unknown>;
const callOf = (handler: IMediaControlHandlerAsync | undefined, name: string): Call | undefined =>
  handler && typeof handler[name] === 'function' ? (handler[name] as unknown as Call) : undefined;

const msOf = (t: ITimeValue | undefined): number =>
  t && Number.isFinite(t.seconds) ? t.seconds * 1000 + Math.round((t.nanoseconds ?? 0) / 1_000_000) : 0;

const timeValue = (ms: number): ITimeValue => {
  const whole = Math.max(0, Math.floor(ms));
  return { seconds: Math.floor(whole / 1000), nanoseconds: (whole % 1000) * 1_000_000 };
};

interface FilmInfo {
  readonly contentId: string;
  readonly durationMs: number;
  readonly mediaId: unknown;
}

/** The film a state is about, read with care: Vega's type leaves `mediaInfo` open. */
function filmInfo(state: MediaSessionState): FilmInfo {
  const info = (state.mediaInfo ?? {}) as { id?: { contentId?: unknown }; duration?: ITimeValue };
  const contentId = typeof info.id?.contentId === 'string' ? info.id.contentId : '';
  return { contentId, durationMs: msOf(info.duration), mediaId: info.id };
}

/**
 * The state as Android's session is told it, or nothing when it says there
 * is no film: Vega's "no film" is a state that offers nothing
 * (media/noFilm.ts NO_FILM).
 */
export function nativeFilm(state: MediaSessionState | undefined, about: { readonly title: string; readonly description: string }): NativeFilm | undefined {
  if (!state || state.capabilities.actions.length === 0) return undefined;
  const info = filmInfo(state);
  return {
    status: state.playbackState.playbackStatus,
    positionMs: msOf(state.playbackState.position?.position),
    speed: state.playbackState.playbackSpeed,
    durationMs: info.durationMs,
    contentId: info.contentId,
    title: about.title,
    description: about.description,
    actions: state.capabilities.actions.map((action) => action.name),
  };
}

export interface FilmSessionServer {
  setHandlerForComponent(handler: IMediaControlHandlerAsync, component: unknown): void;
  updateMediaSessionStates(states: MediaSessionState[]): void;
}

/**
 * The server. `native` is absent in a build without the module, and then
 * nothing is published and no command ever arrives: the film obeys the
 * remote's keys alone, as before.
 */
export function filmSessionServer(native: FilmSessionNative | undefined): FilmSessionServer {
  /** The handler the shared session set last: the film's, or one that refuses everything. */
  let handler: IMediaControlHandlerAsync | undefined;
  /** What the film is called, asked of the handler once per film. */
  let named: { readonly contentId: string; readonly title: string; readonly description: string } | undefined;
  /** One change at a time, in the order asked: a release is never overtaken by the publish before it. */
  let queue: Promise<void> = Promise.resolve();

  native?.onCommand(({ command, deltaMs }) => {
    const name = Object.prototype.hasOwnProperty.call(HANDLER_FOR, command) ? HANDLER_FOR[command] : undefined;
    const call = name ? callOf(handler, name) : undefined;
    if (!call) return;
    // A skip carries the distance asked for, as Vega's does; none, and the rules use the remote's own step.
    const args = deltaMs !== undefined && Number.isFinite(deltaMs) && deltaMs > 0 ? [timeValue(deltaMs)] : [];
    call(...args).catch(() => console.info('media_command_refused', command));
  });

  const nameOf = async (state: MediaSessionState, asked: IMediaControlHandlerAsync | undefined) => {
    const info = filmInfo(state);
    if (named?.contentId === info.contentId) return named;
    const answer = (await callOf(asked, 'handleGetMetadataInfo')?.(info.mediaId).catch(() => undefined)) as
      | { title?: unknown; description?: unknown }
      | undefined;
    named = {
      contentId: info.contentId,
      title: typeof answer?.title === 'string' ? answer.title : '',
      description: typeof answer?.description === 'string' ? answer.description : '',
    };
    return named;
  };

  return {
    setHandlerForComponent(next) {
      handler = next;
    },
    updateMediaSessionStates(states) {
      if (!native) return;
      const state = states[0];
      const asked = handler;
      queue = queue
        .then(async () => {
          const film = state && state.capabilities.actions.length > 0 ? nativeFilm(state, await nameOf(state, asked)) : undefined;
          if (film) await native.publish(film);
          else {
            named = undefined;
            await native.release();
          }
        })
        .catch((e: unknown) => console.warn('media_session_update_failed', e instanceof Error ? e.message : String(e)));
    },
  };
}
