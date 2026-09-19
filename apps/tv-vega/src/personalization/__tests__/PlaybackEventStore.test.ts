import { describe, expect, it } from 'vitest';
import type { FileSystemLike } from '../../headless/QueueStore.js';
import { PlaybackEventStore, toStoredPlaybackEvent, type StoredPlaybackEvent } from '../PlaybackEventStore.js';
import type { PlayerSnapshot } from '../../player/PlayerService.js';

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

const event = (over: Partial<StoredPlaybackEvent> = {}): StoredPlaybackEvent => ({
  contentId: 'ep1',
  contentIdNamespace: 'cdf_id',
  playbackState: 'PLAYING',
  positionMs: 1000,
  durationMs: 600_000,
  eventTimestampMs: 1000,
  ...over,
});

describe('PlaybackEventStore', () => {
  it('starts empty', async () => {
    expect(await new PlaybackEventStore(fakeFs()).all()).toEqual([]);
  });

  it('appends and reads events back', async () => {
    const store = new PlaybackEventStore(fakeFs());
    await store.append(event({ eventTimestampMs: 1000 }));
    await store.append(event({ eventTimestampMs: 2000 }));
    expect((await store.all()).map((e) => e.eventTimestampMs)).toEqual([1000, 2000]);
  });

  it('keeps events sorted by time regardless of append order', async () => {
    const store = new PlaybackEventStore(fakeFs());
    await store.append(event({ eventTimestampMs: 3000 }));
    await store.append(event({ eventTimestampMs: 1000 }));
    expect((await store.all()).map((e) => e.eventTimestampMs)).toEqual([1000, 3000]);
  });

  it('since() returns only events at or after the given time', async () => {
    const store = new PlaybackEventStore(fakeFs());
    await store.append(event({ eventTimestampMs: 1000 }));
    await store.append(event({ eventTimestampMs: 2000 }));
    await store.append(event({ eventTimestampMs: 3000 }));
    expect((await store.since(2000)).map((e) => e.eventTimestampMs)).toEqual([2000, 3000]);
  });

  it('caps retention at 500, dropping the oldest', async () => {
    const store = new PlaybackEventStore(fakeFs());
    for (let i = 0; i < 501; i += 1) {
      await store.append(event({ eventTimestampMs: i }));
    }
    const all = await store.all();
    expect(all).toHaveLength(500);
    expect(all[0]?.eventTimestampMs).toBe(1); // event 0 was dropped
    expect(all.at(-1)?.eventTimestampMs).toBe(500);
  });
});

describe('toStoredPlaybackEvent', () => {
  const snapshot = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
    state: 'PLAYING',
    positionMs: 1000,
    durationMs: 600_000,
    contentId: 'ep1',
    ...over,
  });

  it('maps PLAYING/PAUSED/STOPPED to the platform vocabulary', () => {
    expect(toStoredPlaybackEvent(snapshot({ state: 'PLAYING' }), 'cdf_id', 1)?.playbackState).toBe('PLAYING');
    expect(toStoredPlaybackEvent(snapshot({ state: 'PAUSED' }), 'cdf_id', 1)?.playbackState).toBe('PAUSED');
    expect(toStoredPlaybackEvent(snapshot({ state: 'STOPPED' }), 'cdf_id', 1)?.playbackState).toBe('EXIT');
  });

  it('does not persist BUFFERING — no platform equivalent', () => {
    expect(toStoredPlaybackEvent(snapshot({ state: 'BUFFERING' }), 'cdf_id', 1)).toBeUndefined();
  });

  it('carries creditsPositionMs through only when present', () => {
    expect(toStoredPlaybackEvent(snapshot({ creditsPositionMs: 590_000 }), 'cdf_id', 1)?.creditsPositionMs).toBe(590_000);
    expect(toStoredPlaybackEvent(snapshot(), 'cdf_id', 1)).not.toHaveProperty('creditsPositionMs');
  });
});
