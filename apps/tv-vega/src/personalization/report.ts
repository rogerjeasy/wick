/**
 * Watch Activity, told to the platform as it happens:
 * `ContentPersonalizationServer.reportNewPlaybackEvent`, with an event built
 * the way the SDK's own example builds one (`PlaybackEventBuilder` …
 * `.buildActiveEvent()`). watchActivity.ts decides when; this only says it.
 *
 * The fields Amazon marks required for Watch Activity: the content id, an
 * internal profile id, the duration, the position and the state. The credits
 * position is optional and sent when the programme has one. The event
 * timestamp is left out: for an active event the platform records the moment
 * it is reported.
 *
 * Content ids are in the `cdf_id` namespace (ContentIdNamespaces.
 * NAMESPACE_CDF_ID), the one for an app's own catalogue ids. Wick has no
 * Fire TV catalogue integration — its three films are Blender's open films,
 * in no Amazon catalogue — so the platform has nothing to resolve the ids
 * against, and a Continue Watching row for them is not expected (FRICTION.md
 * FL-043). What can be seen is the platform taking each report:
 * `vega exec loggingctl log -f | grep -Ei 'kepler.tv.personalization'`.
 *
 * One person watches this television (WICK.md §13.3: one resident per
 * household), so there is one profile, named by a constant that carries
 * nothing about her.
 *
 * The SDK is imported lazily, inside the call: looking its TurboModule up is
 * an import-time side effect that throws outside a Vega runtime (handlers.ts
 * says the same). Best effort and silent, like the toast: a report that fails
 * must never stop her film.
 */
import type { IPlaybackEvent } from '@amazon-devices/kepler-content-personalization';
import type { WatchReport } from './watchActivity.js';

/** ContentIdNamespaces.NAMESPACE_CDF_ID, as a string so nothing is imported to name it. */
export const CONTENT_ID_NAMESPACE = 'cdf_id';
/** ProfileIdNamespaces.NAMESPACE_APP_INTERNAL. */
export const PROFILE_ID_NAMESPACE = 'app_internal';
/** The one profile on her television. */
export const PROFILE_ID = 'resident';

type Sdk = typeof import('@amazon-devices/kepler-content-personalization');
type Builders = Pick<Sdk, 'ContentIdBuilder' | 'PlaybackEventBuilder' | 'PlaybackState' | 'ProfileIdBuilder'>;

/** The platform's event for one report. Throws as the SDK's builder does if a required field is missing. */
export function toPlaybackEvent(report: WatchReport, sdk: Builders): IPlaybackEvent {
  const { ContentIdBuilder, PlaybackEventBuilder, PlaybackState, ProfileIdBuilder } = sdk;
  const builder = new PlaybackEventBuilder()
    .contentId(new ContentIdBuilder().id(report.contentId).idNamespace(CONTENT_ID_NAMESPACE).build())
    .profileId(new ProfileIdBuilder().id(PROFILE_ID).idNamespace(PROFILE_ID_NAMESPACE).build())
    .playbackPositionMs(report.positionMs)
    .playbackState(report.state === 'PLAYING' ? PlaybackState.PLAYING : report.state === 'PAUSED' ? PlaybackState.PAUSED : PlaybackState.EXIT)
    .durationMs(report.durationMs);
  if (report.creditsPositionMs !== undefined) builder.creditsPositionMs(report.creditsPositionMs);
  return builder.buildActiveEvent();
}

export type PlaybackReporter = (report: WatchReport) => void;

/**
 * Reports to the platform, one at a time and in order. `load` is the SDK;
 * tests hand in their own. Where the platform has no Content Personalization
 * — the Fire OS build, whose bundler answers every other `@amazon-devices/*`
 * name with an empty module (apps/tv-fireos/src/adapters/unavailable.ts) —
 * it says so once and reports nothing more.
 */
export function platformPlaybackReporter(load: () => Promise<Partial<Builders & Pick<Sdk, 'ContentPersonalizationServer'>>> = () => import('@amazon-devices/kepler-content-personalization')): PlaybackReporter {
  let tail: Promise<void> = Promise.resolve();
  let unavailable = false;
  return (report) => {
    if (unavailable) return;
    tail = tail
      .then(async () => {
        if (unavailable) return;
        const sdk = await load();
        if (!sdk.ContentPersonalizationServer) {
          unavailable = true;
          console.warn('playback_report_unavailable');
          return;
        }
        sdk.ContentPersonalizationServer.reportNewPlaybackEvent(toPlaybackEvent(report, sdk as Builders));
      })
      .catch((err: unknown) => console.error('playback_report_failed', err));
  };
}
