/**
 * Content Personalization's pull handlers — the platform asks, Wick answers,
 * and commits.
 *
 * Wick's Watch Activity is told to the platform as it happens, from the
 * player (report.ts, watchActivity.ts): Amazon's way for what is watched on
 * this device. These handlers answer the platform's other questions, and the
 * answer to each is "nothing", given properly — every provider still gets its
 * commit(), which the platform's contract requires even when nothing is added:
 *
 *   - IPlaybackEventsHandler.getPlaybackEventsSince is for playback that
 *     happened off this device (ContentPersonalizationServer.
 *     reportRefreshedPlaybackEvents: "updates … that occurred off-device that
 *     can be fetched"). All of Wick's playback is on this television and
 *     already reported live; sending it again here, as active events, would
 *     count every evening twice and date it to the moment of the asking.
 *   - Wick has no customer-managed watchlist — it is a care companion, not a
 *     storefront.
 *   - Wick has no purchases, rentals or recordings to report.
 *
 * Shapes verified against the installed
 * @amazon-devices/kepler-content-personalization .d.ts (not the sample's
 * mocked wiring). Only types are imported: the package's value exports look a
 * native TurboModule up as an import-time side effect, which throws outside a
 * Vega runtime.
 */
import type { IContentEntitlementsHandler, ICustomerListEntriesHandler, IPlaybackEventsHandler } from '@amazon-devices/kepler-content-personalization';

export const noopPlaybackEventsHandler: IPlaybackEventsHandler = {
  getPlaybackEventsSince(_since, provider) {
    provider.commit();
  },
};

export const noopCustomerListEntriesHandler: ICustomerListEntriesHandler = {
  getAllCustomerListEntries(_listType, provider) {
    provider.commit();
  },
};

export const noopContentEntitlementsHandler: IContentEntitlementsHandler = {
  getAllContentEntitlements(provider) {
    provider.commit();
  },
};
