/**
 * Stands in for `@amazon-devices/kepler-media-controls` on Fire OS.
 *
 * On Vega the resident's film is a media session of the platform's
 * (apps/tv-vega/src/watch/mediaControls.ts): "Alexa, pause" and the
 * system's transport controls reach it there. On Fire OS the same shared
 * file runs unchanged against this stand-in, and the session it registers
 * is Android's own (`android.media.session.MediaSession`), held by Wick's
 * module (android/.../media/FilmSessionModule.kt). That is where a Fire
 * TV's Alexa, the remote's media keys and the system's transport controls
 * send an app their commands. What is published and what each command
 * becomes is media/filmSession.ts: a command from Android is handed to the
 * shared handler by Vega's own name for it, so it obeys the rules her
 * remote's keys obey (watch/mediaSession.ts) — a held note, Read to me, the
 * door camera, the family seat's refusal.
 *
 * Android's other media session — react-native-video's notification
 * controls — would drive the player directly, around those rules, so it is
 * still not switched on.
 */
import { filmSessionServer, type FilmSessionServer } from '../media/filmSession';
import { nativeFilmSession } from '../media/native';

/** The platform's names for what a session can do. Only the names the shared source uses. */
export class Action {
  constructor(readonly name: string) {}
  static readonly PLAY = new Action('Play');
  static readonly PAUSE = new Action('Pause');
  static readonly TOGGLE_PLAY_PAUSE = new Action('TogglePlayPause');
  static readonly STOP = new Action('Stop');
  static readonly START_OVER = new Action('StartOver');
  static readonly SKIP_FORWARD = new Action('SkipForward');
  static readonly SKIP_BACKWARD = new Action('SkipBackward');
}

export const PlaybackStatus = {
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  NOT_PLAYING: 'NOT_PLAYING',
  BUFFERING: 'BUFFERING',
} as const;
export type PlaybackStatus = (typeof PlaybackStatus)[keyof typeof PlaybackStatus];

export interface ITimeValue {
  seconds: number;
  nanoseconds: number;
}

export interface IMediaSessionId {
  id: number;
}

export interface IMediaMetadata {
  mediaId: unknown;
  title?: string;
  description?: string;
  mediaType?: string;
  artwork: unknown[];
}

export interface MediaSessionState {
  id: IMediaSessionId;
  playbackState: { playbackStatus: PlaybackStatus; playbackSpeed: number; position?: { updatedAtTime: ITimeValue; position: ITimeValue } };
  mediaInfo?: unknown;
  capabilities: { actions: Action[]; speeds: number[]; ratings: number[]; forwardSkipSteps: ITimeValue[]; backwardSkipSteps: ITimeValue[] };
  controls: unknown[];
}

/** Every handler the platform could call. Here only the seven a film obeys, and the one that names it, are ever called. */
export type IMediaControlHandlerAsync = Record<string, (...args: never[]) => Promise<unknown>>;

let server: FilmSessionServer | undefined;

export const MediaControlServerComponentAsync = {
  /** One server for the app, as on Vega: the handler set last is the one that answers. */
  getOrMakeServer(): FilmSessionServer {
    server ??= filmSessionServer(nativeFilmSession);
    return server;
  },
};
