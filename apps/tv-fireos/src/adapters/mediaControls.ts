/**
 * Stands in for `@amazon-devices/kepler-media-controls` on Fire OS.
 *
 * On Vega the resident's film is a media session of the platform's
 * (apps/tv-vega/src/watch/mediaControls.ts): "Alexa, pause" and the
 * system's transport controls reach it there. On Fire OS there is no such
 * session yet. The film obeys the remote's own keys, which arrive as key
 * presses exactly as before (remoteEvents.ts), and nothing else: this
 * server takes the handler it is given and never calls it, and what it is
 * told about the film goes nowhere.
 *
 * Android's own media session (react-native-video's notification controls)
 * would drive the player directly, around the rules the film's commands
 * obey on Vega (watch/mediaSession.ts) — a held note, Read to me, the
 * seat's refusal — so it is not switched on.
 */

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

/** Every handler the platform could call. None is ever called here. */
export type IMediaControlHandlerAsync = Record<string, (...args: never[]) => Promise<unknown>>;

export const MediaControlServerComponentAsync = {
  getOrMakeServer() {
    return {
      setHandlerForComponent(_handler: IMediaControlHandlerAsync, _component: unknown): void {},
      updateMediaSessionStates(_states: MediaSessionState[]): void {},
    };
  },
};
