import { describe, expect, it } from 'vitest';
import type { PlayerSnapshot } from '../../player/PlayerService.js';
import { PlaybackRecorder, toPlaybackDeviceEvent } from '../playbackRecorder.js';

const snap = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({
  state: 'PLAYING',
  positionMs: 1_000,
  durationMs: 600_000,
  creditsPositionMs: 500_000,
  contentId: 'big-buck-bunny',
  ...over,
});

describe('PlaybackRecorder', () => {
  it('records the first playing snapshot', () => {
    const r = new PlaybackRecorder();
    expect(r.shouldRecord(snap())).toBe(true);
  });

  it('does not record a second snapshot in the same state — once a second would be chatter', () => {
    const r = new PlaybackRecorder();
    r.shouldRecord(snap());
    expect(r.shouldRecord(snap({ positionMs: 2_000 }))).toBe(false);
  });

  it('records each change of state', () => {
    const r = new PlaybackRecorder();
    r.shouldRecord(snap());
    expect(r.shouldRecord(snap({ state: 'PAUSED' }))).toBe(true);
    expect(r.shouldRecord(snap({ state: 'PLAYING' }))).toBe(true);
    expect(r.shouldRecord(snap({ state: 'STOPPED' }))).toBe(true);
  });

  it('never records buffering, and buffering does not make the next playing snapshot look new', () => {
    const r = new PlaybackRecorder();
    r.shouldRecord(snap());
    expect(r.shouldRecord(snap({ state: 'BUFFERING' }))).toBe(false);
    expect(r.shouldRecord(snap())).toBe(false);
  });

  it('records a different programme even in the same state', () => {
    const r = new PlaybackRecorder();
    r.shouldRecord(snap());
    expect(r.shouldRecord(snap({ contentId: 'tears-of-steel' }))).toBe(true);
  });
});

describe('toPlaybackDeviceEvent', () => {
  it('carries the snapshot to the cloud contract, with the credits marker', () => {
    expect(toPlaybackDeviceEvent(snap(), 42)).toEqual({
      t: 'playback',
      state: 'PLAYING',
      positionMs: 1_000,
      durationMs: 600_000,
      creditsPositionMs: 500_000,
      contentId: 'big-buck-bunny',
      at: 42,
    });
  });

  it('omits the credits marker when the programme has none', () => {
    const { creditsPositionMs: _omit, ...noCredits } = snap();
    expect(toPlaybackDeviceEvent(noCredits, 42)).not.toHaveProperty('creditsPositionMs');
  });
});
