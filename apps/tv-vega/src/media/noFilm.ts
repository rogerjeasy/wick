/**
 * No film of hers here: the platform's media commands are all refused, and
 * the platform is told there is nothing playing (Vega Media Controls,
 * `@amazon-devices/kepler-media-controls`).
 *
 * Called by a family member's seat beside her film, which has no pause and
 * no skip (family/FamilySeat.tsx; AGENTS.md, "Where a film has got to is the
 * resident's"), and on her television when her film is let go
 * (watch/mediaControls.ts). The platform keeps one handler for the app's
 * component, so the last one set is the one that answers: this one obeys
 * nothing.
 *
 * On Fire OS this package is the stand-in in apps/tv-fireos/src/adapters:
 * "no film" there releases Android's media session, so nothing is left for
 * a command to reach.
 */
import { MediaControlServerComponentAsync, PlaybackStatus } from '@amazon-devices/kepler-media-controls';
import type { IMediaControlHandlerAsync, IMediaSessionId, MediaSessionState } from '@amazon-devices/kepler-media-controls';
import type { IComponentInstance } from '@amazon-devices/react-native-kepler';
import { refusesEverything } from './refusal.js';

/** The one session Wick has: one film at a time. */
export const SESSION: IMediaSessionId = { id: 0 };

/**
 * Nothing playing, nothing offered, about nothing. The platform refuses an
 * empty list of sessions ("Array of MediaSessionState is empty"), so "no
 * film" is said as a state.
 */
export const NO_FILM: MediaSessionState = {
  id: SESSION,
  playbackState: { playbackStatus: PlaybackStatus.NOT_PLAYING, playbackSpeed: 0 },
  capabilities: { actions: [], speeds: [], ratings: [], forwardSkipSteps: [], backwardSkipSteps: [] },
  controls: [],
};

export function mediaServer() {
  return MediaControlServerComponentAsync.getOrMakeServer();
}

/** Every command refused, and no film. Never throws: a platform without media controls has nothing to refuse. */
export function refuseFilmCommands(component: IComponentInstance): void {
  try {
    const s = mediaServer();
    s.setHandlerForComponent(refusesEverything([NO_FILM]) as unknown as IMediaControlHandlerAsync, component);
    s.updateMediaSessionStates([NO_FILM]);
  } catch (e) {
    console.warn('media_session_unavailable', e instanceof Error ? e.message : String(e));
  }
}
