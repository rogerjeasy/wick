/**
 * Wick's film as a media session of the platform's (Vega Media Controls,
 * `@amazon-devices/kepler-media-controls`): the thin part that registers
 * with the platform. What each command does is decided in mediaSession.ts,
 * which is pure and tested there.
 *
 * Registered as the docs' "advanced" mode, with the platform's media
 * control server directly — not by handing the player to the platform
 * (`VideoPlayer.setMediaControlFocus`). Handed over, the player would obey
 * "play" and "pause" by itself, and the platform would be told the player's
 * stock description of itself: a sample media id, eight speeds, ratings and
 * an X-Ray control Wick does not have. Here every command passes through
 * the same rules as her remote's keys, and the platform is told only what
 * is true: which film, its name and the line that credits it, where it has
 * got to, and the six things that can be done to it.
 *
 * The platform keeps one handler for the app's component. When her film is
 * let go — and on a family member's own television, which may never hold
 * one — that handler refuses every command and says there is no session
 * (media/noFilm.ts).
 *
 * On Fire OS this package is the stand-in in apps/tv-fireos/src/adapters,
 * and the session is Android's own: the same handler is called there, by
 * the same names, for Alexa on a Fire TV and the remote's media keys.
 */
import { Action, PlaybackStatus } from '@amazon-devices/kepler-media-controls';
import type {
  IMediaControlHandlerAsync,
  IMediaMetadata,
  ITimeValue,
  MediaSessionState,
} from '@amazon-devices/kepler-media-controls';
import type { IComponentInstance } from '@amazon-devices/react-native-kepler';
import { NO_FILM, SESSION, mediaServer, refuseFilmCommands } from '../media/noFilm.js';
import { refusesEverything } from '../media/refusal.js';
import {
  fromTimeValue,
  sessionMetadata,
  sessionView,
  shouldPublish,
  toTimeValue,
  type MediaCommand,
  type SessionAction,
  type SessionSnapshot,
  type SessionView,
} from './mediaSession.js';

/** The catalogue the films' ids belong to: Wick's own (catalog/catalog.ts). */
const CATALOG_NAME = 'wick';

const ACTIONS: Readonly<Record<SessionAction, Action>> = {
  PLAY: Action.PLAY,
  PAUSE: Action.PAUSE,
  TOGGLE_PLAY_PAUSE: Action.TOGGLE_PLAY_PAUSE,
  STOP: Action.STOP,
  START_OVER: Action.START_OVER,
  SKIP_FORWARD: Action.SKIP_FORWARD,
  SKIP_BACKWARD: Action.SKIP_BACKWARD,
};

const STATUS: Readonly<Record<SessionView['status'], PlaybackStatus>> = {
  PLAYING: PlaybackStatus.PLAYING,
  PAUSED: PlaybackStatus.PAUSED,
  BUFFERING: PlaybackStatus.BUFFERING,
  NOT_PLAYING: PlaybackStatus.NOT_PLAYING,
};

function toState(view: SessionView): MediaSessionState {
  const duration = toTimeValue(view.durationMs);
  const step = toTimeValue(view.skipStepMs);
  return {
    id: SESSION,
    playbackState: {
      playbackStatus: STATUS[view.status],
      playbackSpeed: view.speed,
      position: { updatedAtTime: toTimeValue(view.updatedAtMs), position: toTimeValue(view.positionMs) },
    },
    mediaInfo: {
      id: { contentId: view.contentId, catalogName: CATALOG_NAME },
      hasVideo: true,
      availableAudioTracks: [],
      availableTextTracks: [],
      duration,
      seekRangeStart: toTimeValue(0),
      seekRangeEnd: duration,
    },
    capabilities: {
      actions: view.actions.map((name) => ACTIONS[name]),
      speeds: [1],
      ratings: [],
      forwardSkipSteps: [step],
      backwardSkipSteps: [step],
    },
    controls: [],
  };
}

export interface FilmSession {
  /** Where the film is now. The platform is told when it needs to be (mediaSession.ts shouldPublish). */
  publish(snapshot: SessionSnapshot | undefined): void;
  /** The film is let go: no session, and every command refused. */
  end(): void;
}

/**
 * Her film, as the platform's media session. `command` is called for each
 * command Wick obeys and does what mediaSession.ts `mediaOutcome` says;
 * everything else is refused here. Never throws: a platform without media
 * controls leaves the film exactly as it was, on the keys alone.
 */
export function startFilmSession(input: {
  readonly component: IComponentInstance;
  readonly programme: { readonly id: string; readonly title: string; readonly attribution: string };
  readonly command: (command: MediaCommand, deltaMs?: number) => void;
}): FilmSession {
  let last: SessionView | undefined;
  let ended = false;
  const obey = (command: MediaCommand, deltaMs?: number): Promise<void> => {
    // The command's name and nothing else, in the device's own log: which way it came is all there is to see.
    console.info('media_command', command, ended ? 'after_end' : '');
    if (!ended) input.command(command, deltaMs);
    return Promise.resolve();
  };
  const refuse = refusesEverything([NO_FILM]);

  const handler: IMediaControlHandlerAsync = {
    ...refuse,
    handlePlay: () => obey('play'),
    handlePause: () => obey('pause'),
    handleTogglePlayPause: () => obey('toggle'),
    handleStop: () => obey('stop'),
    handleStartOver: () => obey('startOver'),
    handleSkipForward: (delta: ITimeValue) => obey('skipForward', fromTimeValue(delta)),
    handleSkipBackward: (delta: ITimeValue) => obey('skipBackward', fromTimeValue(delta)),
    handleGetMetadataInfo: (id) => {
      const metadata = sessionMetadata(input.programme);
      const answer: IMediaMetadata = { mediaId: id, title: metadata.title, description: metadata.description, mediaType: metadata.mediaType, artwork: [] };
      return Promise.resolve(answer);
    },
    handleGetSessionState: () => Promise.resolve([last && !ended ? toState(last) : NO_FILM]),
  };

  try {
    mediaServer().setHandlerForComponent(handler, input.component);
  } catch (e) {
    console.warn('media_session_unavailable', e instanceof Error ? e.message : String(e));
  }

  return {
    publish(snapshot) {
      if (ended || !snapshot) return;
      const view = sessionView(snapshot, Date.now());
      if (!shouldPublish(last, view)) return;
      last = view;
      try {
        mediaServer().updateMediaSessionStates([toState(view)]);
      } catch (e) {
        console.warn('media_session_update_failed', e instanceof Error ? e.message : String(e));
      }
    },
    end() {
      if (ended) return;
      ended = true;
      refuseFilmCommands(input.component);
    },
  };
}
