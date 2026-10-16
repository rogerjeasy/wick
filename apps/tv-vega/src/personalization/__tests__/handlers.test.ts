import { describe, expect, it } from 'vitest';
import { noopContentEntitlementsHandler, noopCustomerListEntriesHandler, noopPlaybackEventsHandler } from '../handlers.js';

/**
 * The platform's pulls (handlers.ts): each is answered with nothing, and
 * committed — the platform's contract needs the commit even then. Her
 * playback is reported live instead (report.ts), so the pull for
 * off-device playback adds nothing, rather than sending this television's
 * own evenings a second time.
 */
describe('the Content Personalization pull handlers', () => {
  it('answer the pull for playback with nothing, and commit', () => {
    const chunks: unknown[] = [];
    const commits: boolean[] = [];
    noopPlaybackEventsHandler.getPlaybackEventsSince(new Date(0), {
      addPlaybackEventChunk: (chunk) => chunks.push(chunk),
      commit: () => commits.push(true),
    });
    expect(chunks).toEqual([]);
    expect(commits).toEqual([true]);
  });

  it('commit the watchlist and entitlement pulls with nothing added — the correct empty response, not a stub', () => {
    const listCommits: boolean[] = [];
    noopCustomerListEntriesHandler.getAllCustomerListEntries(0, { addCustomerListChunk: () => undefined, commit: () => listCommits.push(true) });
    expect(listCommits).toEqual([true]);

    const entitlementCommits: boolean[] = [];
    noopContentEntitlementsHandler.getAllContentEntitlements({
      addContentEntitlementChunk: () => undefined,
      commit: () => entitlementCommits.push(true),
    });
    expect(entitlementCommits).toEqual([true]);
  });
});
