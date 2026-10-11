import { describe, expect, it, vi } from 'vitest';
import { storageFileSystem, type KeyValueStorage } from '../adapters/storageFileSystem.js';
import { toVegaEvent } from '../adapters/remoteEvents.js';
import { VideoPlayer } from '../adapters/videoPlayer.js';
import { deriveSnapshot, PlayerService, type MediaElementLike, type PlayerSnapshot } from '../../../tv-vega/src/player/PlayerService.js';
import { watchCommand } from '../../../tv-vega/src/watch/remoteKeys.js';
import { QueueStore } from '../../../tv-vega/src/headless/QueueStore.js';
import { resolveDeviceId, SIMULATOR_DEVICE_ID } from '../../../tv-vega/src/deviceId.js';

function memoryStorage(): KeyValueStorage & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: async (key) => kept.get(key) ?? null,
    setItem: async (key, value) => {
      kept.set(key, value);
    },
  };
}

describe('storageFileSystem', () => {
  it('reads back what was written, and says how much was written', async () => {
    const fs = storageFileSystem(memoryStorage());

    expect(await fs.writeStringToFile('/data/wick-token.json', '{"jwt":"a"}', 'utf8')).toBe(11);
    expect(await fs.readFileAsString('/data/wick-token.json', 'utf8')).toBe('{"jwt":"a"}');
  });

  it('knows a file that exists from one that does not, and refuses to read the second', async () => {
    const fs = storageFileSystem(memoryStorage());
    await fs.writeStringToFile('/data/a.json', '', 'utf8');

    expect(await fs.exists('/data/a.json')).toBe(true);
    expect(await fs.exists('/data/b.json')).toBe(false);
    await expect(fs.readFileAsString('/data/b.json', 'utf8')).rejects.toThrow('no such file');
  });

  it('keeps its files apart from anything else in the same storage', async () => {
    const storage = memoryStorage();
    storage.kept.set('/data/a.json', 'not ours');

    expect(await storageFileSystem(storage).exists('/data/a.json')).toBe(false);
  });

  it('gives this television an id of its own that is the same on the next launch — not the simulator\'s', async () => {
    const storage = memoryStorage();

    const first = await resolveDeviceId(storageFileSystem(storage));
    const again = await resolveDeviceId(storageFileSystem(storage));

    expect(first).not.toBe(SIMULATOR_DEVICE_ID);
    expect(again).toBe(first);
  });

  it('holds the card queue the Vega app keeps in files', async () => {
    const storage = memoryStorage();
    const card = { id: 'c1', urgency: 'DOOR', receivedAt: 1, card: { type: 'DOOR', line: 'Someone is at the door.' } };

    await new QueueStore(storageFileSystem(storage)).upsert(card as never);

    expect((await new QueueStore(storageFileSystem(storage)).readAll()).map((c) => c.id)).toEqual(['c1']);
  });
});

describe('toVegaEvent', () => {
  it('renames the media keys to the names the Vega app listens for', () => {
    expect(toVegaEvent({ eventType: 'playPause', eventKeyAction: 0 })?.eventType).toBe('playpause');
    expect(toVegaEvent({ eventType: 'fastForward', eventKeyAction: 0 })?.eventType).toBe('skip_forward');
    expect(toVegaEvent({ eventType: 'rewind', eventKeyAction: 0 })?.eventType).toBe('skip_backward');
  });

  it('passes the D-pad and select through as they are', () => {
    expect(toVegaEvent({ eventType: 'select', eventKeyAction: 0 })).toEqual({ eventType: 'select', eventKeyAction: 0 });
    expect(toVegaEvent({ eventType: 'left' })).toEqual({ eventType: 'left', eventKeyAction: 0 });
  });

  it('says nothing for a key coming back up: the press was acted on when it went down', () => {
    expect(toVegaEvent({ eventType: 'select', eventKeyAction: 1 })).toBeUndefined();
  });

  it('says nothing for focus moving, which arrives the same way', () => {
    expect(toVegaEvent({ eventType: 'focus' })).toBeUndefined();
    expect(toVegaEvent({ eventType: 'blur' })).toBeUndefined();
    expect(toVegaEvent(null)).toBeUndefined();
  });

  it('gives the Vega app\'s own key map what it acts on', () => {
    const press = (eventType: string) => watchCommand(toVegaEvent({ eventType, eventKeyAction: 0 })!, { cardVisible: false });

    expect(press('playPause')).toBe('toggle');
    expect(press('fastForward')).toBe('forward');
    expect(press('rewind')).toBe('back');
    expect(press('select')).toBe('toggle');
  });
});

describe('VideoPlayer', () => {
  it('is everything PlayerService reads from a player', () => {
    const media: MediaElementLike = new VideoPlayer();

    expect(media.paused).toBe(true);
  });

  it('starts paused with nothing loaded', () => {
    const player = new VideoPlayer();

    expect(deriveSnapshot(player, 'sintel', undefined)).toMatchObject({ state: 'PAUSED', positionMs: 0, durationMs: 0 });
  });

  it('is buffering from play until the picture moves, then playing', async () => {
    const player = new VideoPlayer();
    const heard: string[] = [];
    for (const type of ['play', 'playing', 'waiting']) player.addEventListener(type, () => heard.push(type));
    player.src = 'https://wick.test/sintel.m3u8';

    await player.play();
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('BUFFERING');

    player.reportLoaded(888);
    player.reportProgress(0.25);
    player.reportProgress(0.5);

    expect(deriveSnapshot(player, 'sintel', undefined)).toMatchObject({ state: 'PLAYING', positionMs: 500, durationMs: 888_000 });
    expect(heard).toEqual(['play', 'playing']);
  });

  it('is buffering again when the stream stalls, and playing when it comes back', async () => {
    const player = new VideoPlayer();
    const heard: string[] = [];
    for (const type of ['playing', 'waiting']) player.addEventListener(type, () => heard.push(type));
    await player.play();
    player.reportProgress(1);

    player.reportBuffering(true);
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('BUFFERING');

    player.reportBuffering(false);
    player.reportProgress(1.2);
    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('PLAYING');
    expect(heard).toEqual(['playing', 'waiting', 'playing']);
  });

  it('pauses once, and tells the view each time what it should be doing changes', async () => {
    const player = new VideoPlayer();
    const redraw = vi.fn();
    const paused = vi.fn();
    player.watch(redraw);
    player.addEventListener('pause', paused);

    await player.play();
    player.pause();
    player.pause();

    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('PAUSED');
    expect(paused).toHaveBeenCalledTimes(1);
    expect(redraw).toHaveBeenCalledTimes(2);
  });

  it('takes a seek at once, so two quick presses skip twice, and passes each to the view', async () => {
    const player = new VideoPlayer();
    const seek = vi.fn();
    player.attach({ seek });
    await player.play();
    player.reportProgress(10);

    player.currentTime = player.currentTime + 30;
    player.currentTime = player.currentTime + 30;

    expect(player.currentTime).toBe(70);
    expect(seek.mock.calls).toEqual([[40], [70]]);
  });

  it('has ended when the programme has, which the watch screen takes as stopped', async () => {
    const player = new VideoPlayer();
    const ended = vi.fn();
    player.addEventListener('ended', ended);
    await player.play();
    player.reportProgress(887);

    player.reportEnded();

    expect(deriveSnapshot(player, 'sintel', undefined).state).toBe('STOPPED');
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('plays a second programme from the start after the first ended', async () => {
    const player = new VideoPlayer();
    await player.play();
    player.reportProgress(887);
    player.reportEnded();

    player.src = 'https://wick.test/big-buck-bunny.m3u8';
    await player.play();

    expect(deriveSnapshot(player, 'bbb', undefined)).toMatchObject({ state: 'BUFFERING', positionMs: 0 });
  });

  it('reports a failure to whoever asked, and stops listening to anyone once it is given up', async () => {
    const player = new VideoPlayer();
    const failed = vi.fn();
    player.addEventListener('error', failed);

    player.reportError();
    await player.deinitialize();
    player.reportError();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(player.src).toBe('');
  });

  it('gives PlayerService a snapshot on each change of state, as the Vega player does', async () => {
    const player = new VideoPlayer();
    const service = new PlayerService(player, { setIntervalImpl: (() => 0) as never, clearIntervalImpl: (() => {}) as never });
    const states: PlayerSnapshot['state'][] = [];
    service.onSnapshot((s) => states.push(s.state));
    service.start();
    service.load('sintel');

    await player.play();
    player.reportProgress(1);
    player.pause();
    player.reportEnded();

    expect(states).toEqual(['PAUSED', 'BUFFERING', 'PLAYING', 'PAUSED', 'STOPPED']);
  });
});
