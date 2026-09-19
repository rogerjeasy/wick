/**
 * Content Personalization handlers — the platform pulls, we push chunks, commit.
 *
 * Two purposes from one integration: the platform gets correct Continue Watching
 * behaviour, and Wick gets a genuine behavioural signal with no new sensor.
 *
 * Shape verified against the installed @amazon-devices/kepler-content-personalization
 * .d.ts (not the sample's mocked wiring):
 *   IPlaybackEventsHandler.getPlaybackEventsSince(since, provider)
 *     -> provider.addPlaybackEventChunk(chunk) ... provider.commit()
 *   ICustomerListEntriesHandler.getAllCustomerListEntries(listType, provider)
 *   IContentEntitlementsHandler.getAllContentEntitlements(provider)
 *
 * IPlaybackEvent is built with PlaybackEventBuilder and terminated by
 * .buildActiveEvent(). Its creditsPositionMs field is the platform's own model of
 * "the episode is ending" — the AT_BREAK signal, free.
 *
 * ContentIdBuilder/PlaybackEventBuilder/PlaybackState are imported lazily,
 * inside the function that needs them, not at module top level — the same
 * reason CardService.ts lazy-imports KeplerFileSystem: importing this
 * package's value exports triggers a native TurboModule lookup as an
 * import-time side effect, which throws outside a real Vega runtime and
 * would crash this module (and anything that imports it, including its own
 * tests) before a test ever gets a chance to run. Only *type* imports are
 * static below — those have no runtime presence.
 */
import type {
  IContentEntitlementsHandler,
  ICustomerListEntriesHandler,
  IPlaybackEvent,
  IPlaybackEventsHandler,
  IPlaybackEventsProvider,
} from '@amazon-devices/kepler-content-personalization';
import type { PlaybackEventStore, StoredPlaybackEvent } from './PlaybackEventStore.js';

/** Paginated per the API doc's own guidance: avoid loading a large list into memory at once. */
const CHUNK_SIZE = 50;

type Sdk = typeof import('@amazon-devices/kepler-content-personalization');

function toIPlaybackEvent(stored: StoredPlaybackEvent, sdk: Pick<Sdk, 'ContentIdBuilder' | 'PlaybackEventBuilder' | 'PlaybackState'>): IPlaybackEvent {
  const { ContentIdBuilder, PlaybackEventBuilder, PlaybackState } = sdk;

  const contentId = new ContentIdBuilder().id(stored.contentId).idNamespace(stored.contentIdNamespace).build();
  const platformState =
    stored.playbackState === 'PLAYING'
      ? PlaybackState.PLAYING
      : stored.playbackState === 'PAUSED'
        ? PlaybackState.PAUSED
        : PlaybackState.EXIT;

  const builder = new PlaybackEventBuilder()
    .contentId(contentId)
    .playbackPositionMs(stored.positionMs)
    .playbackState(platformState)
    .eventTimestamp(new Date(stored.eventTimestampMs));

  if (stored.durationMs !== undefined) builder.durationMs(stored.durationMs);
  if (stored.creditsPositionMs !== undefined) builder.creditsPositionMs(stored.creditsPositionMs);

  return builder.buildActiveEvent();
}

async function respondWithStoredEvents(store: PlaybackEventStore, since: Date, provider: IPlaybackEventsProvider): Promise<void> {
  // Imported once per call, not once per event — 500 concurrent dynamic
  // imports of the same specifier is needless churn even though ESM caches
  // the module after the first resolution.
  const sdk = await import('@amazon-devices/kepler-content-personalization');
  const events = await store.since(since.getTime());
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE).map((e) => toIPlaybackEvent(e, sdk));
    provider.addPlaybackEventChunk(chunk);
  }
  provider.commit();
}

export function createPlaybackEventsHandler(store: PlaybackEventStore): IPlaybackEventsHandler {
  return {
    getPlaybackEventsSince(sinceTimestamp, provider) {
      // The interface is synchronous/callback-shaped; the store read is
      // async. There is nothing to await here — the provider is the
      // response channel, and calling commit() late is exactly what an
      // async chunk producer is for (the handler doc's own paging guidance
      // implies exactly this shape).
      void respondWithStoredEvents(store, sinceTimestamp, provider);
    },
  };
}

/**
 * Wick has no customer-managed watchlist — it is a care companion, not a
 * storefront. Committing immediately with an empty response is the correct
 * answer to "what's on this list", not a stub: the platform's own contract
 * requires a commit() even when there is nothing to add.
 */
export const noopCustomerListEntriesHandler: ICustomerListEntriesHandler = {
  getAllCustomerListEntries(_listType, provider) {
    provider.commit();
  },
};

/** Same reasoning as the list handler above — Wick has no purchases, rentals or recordings to report. */
export const noopContentEntitlementsHandler: IContentEntitlementsHandler = {
  getAllContentEntitlements(provider) {
    provider.commit();
  },
};
