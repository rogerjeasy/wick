/**
 * Content Personalization handlers — the platform pulls, we push chunks, commit.
 *
 * Two purposes from one integration: the platform gets correct Continue Watching
 * behaviour, and Wick gets a genuine behavioural signal with no new sensor.
 *
 * Shape verified against AmazonAppDev/vega-video-sample/src/headless/
 * DataRefreshService.ts (2026-09-14):
 *   IPlaybackEventsHandler.getPlaybackEventsSince(since, provider)
 *     -> provider.addPlaybackEventChunk(chunk) ... provider.commit()
 *   ICustomerListEntriesHandler.getAllCustomerListEntries(listType, provider)
 *   IContentEntitlementsHandler.getAllContentEntitlements(provider)
 *
 * IPlaybackEvent is built with PlaybackEventBuilder and terminated by
 * .buildActiveEvent(). Its creditsPositionMs field is the platform's own model of
 * "the episode is ending" — the AT_BREAK signal, free.
 */
export {};
