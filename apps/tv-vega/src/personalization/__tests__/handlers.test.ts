import { describe, expect, it, vi } from 'vitest';
import type { IPlaybackEvent, IPlaybackEventsProvider } from '@amazon-devices/kepler-content-personalization';
import type { FileSystemLike } from '../../headless/QueueStore.js';
import { PlaybackEventStore, type StoredPlaybackEvent } from '../PlaybackEventStore.js';

/**
 * The real @amazon-devices/kepler-content-personalization throws on import
 * outside a Vega runtime (a native TurboModule lookup as an import-time side
 * effect — see handlers.ts's own header). handlers.ts already isolates that
 * behind a lazy `await import(...)` so it never fires at module load; this
 * mock supplies a minimal, spec-shaped fake for the one place that dynamic
 * import actually runs, so the chunking/mapping logic this file is testing
 * can execute without a device.
 */
vi.mock('@amazon-devices/kepler-content-personalization', () => {
  class ContentIdBuilder {
    #id = '';
    #ns = '';
    id(v: string) {
      this.#id = v;
      return this;
    }
    idNamespace(v: string) {
      this.#ns = v;
      return this;
    }
    build() {
      return { id: this.#id, idNamespace: this.#ns };
    }
  }
  class PlaybackEventBuilder {
    #fields: Record<string, unknown> = {};
    contentId(v: unknown) {
      this.#fields.contentId = v;
      return this;
    }
    playbackPositionMs(v: number) {
      this.#fields.playbackPositionMs = v;
      return this;
    }
    playbackState(v: unknown) {
      this.#fields.playbackState = v;
      return this;
    }
    eventTimestamp(v: Date) {
      this.#fields.eventTimestamp = v;
      return this;
    }
    durationMs(v: number) {
      this.#fields.durationMs = v;
      return this;
    }
    creditsPositionMs(v: number) {
      this.#fields.creditsPositionMs = v;
      return this;
    }
    buildActiveEvent() {
      return this.#fields;
    }
  }
  const PlaybackState = { PLAYING: 0, PAUSED: 1, EXIT: 2, INTERSTITIAL: 3 };
  return { ContentIdBuilder, PlaybackEventBuilder, PlaybackState };
});

const { createPlaybackEventsHandler, noopContentEntitlementsHandler, noopCustomerListEntriesHandler } = await import('../handlers.js');

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

function fakeProvider(): IPlaybackEventsProvider & { readonly chunks: IPlaybackEvent[][]; readonly committed: boolean[] } {
  const chunks: IPlaybackEvent[][] = [];
  const committed: boolean[] = [];
  return {
    chunks,
    committed,
    addPlaybackEventChunk(events: IPlaybackEvent[]) {
      chunks.push(events);
    },
    commit() {
      committed.push(true);
    },
  };
}

const event = (over: Partial<StoredPlaybackEvent> = {}): StoredPlaybackEvent => ({
  contentId: 'ep1',
  contentIdNamespace: 'cdf_id',
  playbackState: 'PLAYING',
  positionMs: 1000,
  durationMs: 600_000,
  eventTimestampMs: 1000,
  ...over,
});

// getPlaybackEventsSince is fire-and-forget over a chain of awaits (dynamic
// import + store read) with no promise the caller can await directly.
// A single setTimeout(0) macrotask is enough microtask draining most of the
// time, but is not guaranteed — under full-suite load it can fire before
// the second await resolves, producing an intermittent false failure here.
// Waiting for the provider's own commit() callback ties the wait to the
// real completion signal instead of a fixed timer.
function flush(provider: { readonly committed: boolean[] }): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (provider.committed.length > 0 || Date.now() - start > 1000) {
        resolve();
        return;
      }
      setTimeout(check, 0);
    };
    check();
  });
}

describe('createPlaybackEventsHandler', () => {
  it('responds with events since the given time, then commits', async () => {
    const store = new PlaybackEventStore(fakeFs());
    await store.append(event({ eventTimestampMs: 1000 }));
    await store.append(event({ eventTimestampMs: 2000 }));

    const provider = fakeProvider();
    createPlaybackEventsHandler(store).getPlaybackEventsSince(new Date(1500), provider);
    await flush(provider);

    const built = provider.chunks.flat() as unknown as { contentId: { id: string }; playbackPositionMs: number }[];
    expect(built).toHaveLength(1);
    expect(built[0]?.contentId.id).toBe('ep1');
    expect(built[0]?.playbackPositionMs).toBe(1000);
    expect(provider.committed).toEqual([true]);
  });

  it('maps EXIT (STOPPED) correctly and carries creditsPositionMs through', async () => {
    const store = new PlaybackEventStore(fakeFs());
    await store.append(event({ playbackState: 'EXIT', creditsPositionMs: 590_000 }));
    const provider = fakeProvider();
    createPlaybackEventsHandler(store).getPlaybackEventsSince(new Date(0), provider);
    await flush(provider);

    const built = provider.chunks.flat() as unknown as { playbackState: number; creditsPositionMs: number }[];
    expect(built[0]?.playbackState).toBe(2); // PlaybackState.EXIT
    expect(built[0]?.creditsPositionMs).toBe(590_000);
  });

  it('chunks large result sets rather than sending one giant list', async () => {
    const store = new PlaybackEventStore(fakeFs());
    for (let i = 0; i < 120; i += 1) await store.append(event({ eventTimestampMs: i }));

    const provider = fakeProvider();
    createPlaybackEventsHandler(store).getPlaybackEventsSince(new Date(0), provider);
    await flush(provider);

    expect(provider.chunks.length).toBe(3); // 50 + 50 + 20
    expect(provider.chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(provider.committed).toEqual([true]);
  });

  it('still commits when there is nothing to send', async () => {
    const store = new PlaybackEventStore(fakeFs());
    const provider = fakeProvider();
    createPlaybackEventsHandler(store).getPlaybackEventsSince(new Date(0), provider);
    await flush(provider);

    expect(provider.chunks).toEqual([]);
    expect(provider.committed).toEqual([true]);
  });
});

describe('noopCustomerListEntriesHandler / noopContentEntitlementsHandler', () => {
  it('both commit immediately with nothing added — the correct empty response, not a stub', () => {
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
