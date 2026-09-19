import { describe, it, expect, vi } from 'vitest';
import { PlayerService, deriveSnapshot, type MediaElementLike } from '../PlayerService.js';

function fakeMedia(over: Partial<MediaElementLike> = {}): MediaElementLike {
  const listeners = new Map<string, Set<() => void>>();
  return {
    currentTime: 0,
    duration: 1200,
    paused: false,
    ended: false,
    readyState: 4,
    volume: 1,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    ...over,
  };
}

describe('deriveSnapshot', () => {
  it('reports PLAYING when not paused, not ended, and buffered enough', () => {
    const media = fakeMedia({ currentTime: 30, duration: 600, readyState: 4 });
    expect(deriveSnapshot(media, 'ep1', undefined)).toEqual({
      state: 'PLAYING',
      positionMs: 30_000,
      durationMs: 600_000,
      contentId: 'ep1',
    });
  });

  it('reports PAUSED when paused', () => {
    expect(deriveSnapshot(fakeMedia({ paused: true }), 'ep1', undefined).state).toBe('PAUSED');
  });

  it('reports STOPPED when ended, even if also reported paused', () => {
    expect(deriveSnapshot(fakeMedia({ ended: true, paused: true }), 'ep1', undefined).state).toBe('STOPPED');
  });

  it('reports BUFFERING when playing but not enough data is ready', () => {
    expect(deriveSnapshot(fakeMedia({ paused: false, readyState: 2 }), 'ep1', undefined).state).toBe('BUFFERING');
  });

  it('carries creditsPositionMs through when supplied, and omits it when not', () => {
    expect(deriveSnapshot(fakeMedia(), 'ep1', 590_000).creditsPositionMs).toBe(590_000);
    expect(deriveSnapshot(fakeMedia(), 'ep1', undefined)).not.toHaveProperty('creditsPositionMs');
  });

  it('treats a non-finite duration (metadata not yet loaded) as 0, never NaN', () => {
    expect(deriveSnapshot(fakeMedia({ duration: NaN }), 'ep1', undefined).durationMs).toBe(0);
  });
});

describe('PlayerService', () => {
  it('emits a snapshot immediately on load()', () => {
    const service = new PlayerService(fakeMedia());
    const snapshots: unknown[] = [];
    service.onSnapshot((s) => snapshots.push(s));
    service.load('ep1', 590_000);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ contentId: 'ep1', creditsPositionMs: 590_000 });
  });

  it('samples at the configured interval (1Hz by default)', () => {
    vi.useFakeTimers();
    try {
      const service = new PlayerService(fakeMedia(), { sampleIntervalMs: 1000 });
      const snapshots: unknown[] = [];
      service.onSnapshot((s) => snapshots.push(s));
      service.load('ep1');
      service.start();
      vi.advanceTimersByTime(3500);
      // 1 from load() + 3 ticks within 3500ms.
      expect(snapshots.length).toBe(4);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits an extra snapshot on a state-change event, out of cadence', () => {
    let playHandler: (() => void) | undefined;
    const media = fakeMedia({
      addEventListener(type, listener) {
        if (type === 'play') playHandler = listener;
      },
    });
    const service = new PlayerService(media, { setIntervalImpl: (() => 0) as unknown as typeof setInterval });
    const snapshots: unknown[] = [];
    service.onSnapshot((s) => snapshots.push(s));
    service.load('ep1');
    service.start();
    expect(snapshots).toHaveLength(1);
    playHandler?.();
    expect(snapshots).toHaveLength(2);
  });

  it('stop() removes listeners and clears the timer — no snapshot after stop', () => {
    vi.useFakeTimers();
    try {
      const service = new PlayerService(fakeMedia(), { sampleIntervalMs: 500 });
      const snapshots: unknown[] = [];
      service.onSnapshot((s) => snapshots.push(s));
      service.load('ep1');
      service.start();
      service.stop();
      const countAfterStop = snapshots.length;
      vi.advanceTimersByTime(5000);
      expect(snapshots.length).toBe(countAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it('duck() lowers volume without muting, and remembers the level to restore', () => {
    const media = fakeMedia({ volume: 1 });
    const service = new PlayerService(media, { duckedVolume: 0.5 });
    service.duck();
    expect(media.volume).toBe(0.5);
    service.unduck();
    expect(media.volume).toBe(1);
  });

  it('unduck() never restores to 0', () => {
    const media = fakeMedia({ volume: 0 });
    const service = new PlayerService(media, { duckedVolume: 0.5 });
    service.unduck();
    expect(media.volume).toBeGreaterThan(0);
  });

  it('duck() is idempotent — ducking twice does not compound toward 0', () => {
    const media = fakeMedia({ volume: 1 });
    const service = new PlayerService(media, { duckedVolume: 0.5 });
    service.duck();
    service.duck();
    expect(media.volume).toBe(0.5);
    service.unduck();
    expect(media.volume).toBe(1);
  });
});
