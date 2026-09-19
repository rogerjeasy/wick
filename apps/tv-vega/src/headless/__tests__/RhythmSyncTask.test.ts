import { describe, expect, it, afterEach } from 'vitest';
import doRhythmSync, { __setRhythmSyncTestDeps } from '../RhythmSyncTask.js';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';
import { PlaybackEventStore, type StoredPlaybackEvent } from '../../personalization/PlaybackEventStore.js';

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

afterEach(() => {
  __setRhythmSyncTestDeps(null);
});

describe('doRhythmSync', () => {
  it('does nothing when there are no local playback events', async () => {
    const fs = fakeFs();
    __setRhythmSyncTestDeps({ fs });

    await doRhythmSync();

    const queue = new QueueStore(fs);
    expect(await queue.drainOutbound()).toEqual([]);
  });

  it('enqueues every stored playback event as an outbound "playback" DeviceEvent', async () => {
    const fs = fakeFs();
    const store = new PlaybackEventStore(fs);
    await store.append(event({ eventTimestampMs: 1000 }));
    await store.append(event({ eventTimestampMs: 2000 }));
    __setRhythmSyncTestDeps({ fs });

    await doRhythmSync();

    const queue = new QueueStore(fs);
    const outbound = await queue.drainOutbound();
    expect(outbound).toEqual([
      { t: 'playback', state: 'PLAYING', positionMs: 1000, durationMs: 600_000, contentId: 'ep1', at: 1000 },
      { t: 'playback', state: 'PLAYING', positionMs: 1000, durationMs: 600_000, contentId: 'ep1', at: 2000 },
    ]);
  });

  it('maps EXIT to STOPPED and carries creditsPositionMs through', async () => {
    const fs = fakeFs();
    const store = new PlaybackEventStore(fs);
    await store.append(event({ playbackState: 'EXIT', creditsPositionMs: 590_000, eventTimestampMs: 1000 }));
    __setRhythmSyncTestDeps({ fs });

    await doRhythmSync();

    const queue = new QueueStore(fs);
    const outbound = await queue.drainOutbound();
    expect(outbound).toEqual([
      { t: 'playback', state: 'STOPPED', positionMs: 1000, durationMs: 600_000, creditsPositionMs: 590_000, contentId: 'ep1', at: 1000 },
    ]);
  });

  it('does not resend events already synced on a prior run', async () => {
    const fs = fakeFs();
    const store = new PlaybackEventStore(fs);
    await store.append(event({ eventTimestampMs: 1000 }));
    __setRhythmSyncTestDeps({ fs });

    await doRhythmSync();
    const queue = new QueueStore(fs);
    await queue.drainOutbound(); // first run's batch, already "sent"

    await store.append(event({ eventTimestampMs: 2000 }));
    await doRhythmSync();

    expect(await queue.drainOutbound()).toEqual([
      { t: 'playback', state: 'PLAYING', positionMs: 1000, durationMs: 600_000, contentId: 'ep1', at: 2000 },
    ]);
  });
});
