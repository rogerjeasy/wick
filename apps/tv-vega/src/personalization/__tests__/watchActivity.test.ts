/**
 * Amazon's "When to Send" for Watch Activity (watchActivity.ts), driven
 * the way the player drives it: one snapshot a second.
 */
import { describe, expect, it } from 'vitest';
import type { PlayerSnapshot } from '../../player/PlayerService.js';
import { REPORT_EVERY_MS, WatchActivity } from '../watchActivity.js';

const T0 = 1_000_000;
const film = (state: PlayerSnapshot['state'], positionMs: number, contentId = 'big-buck-bunny'): PlayerSnapshot => ({
  state,
  positionMs,
  durationMs: 596_000,
  creditsPositionMs: 580_000,
  contentId,
});

/** Plays from `fromMs` for `seconds`, one snapshot a second; returns the reports, by second. */
function play(activity: WatchActivity, fromMs: number, seconds: number, startAt: number) {
  const reports: { readonly second: number; readonly state: string; readonly positionMs: number }[] = [];
  for (let s = 0; s < seconds; s += 1) {
    const r = activity.next(film('PLAYING', fromMs + s * 1000), startAt + s * 1000);
    if (r) reports.push({ second: s, state: r.state, positionMs: r.positionMs });
  }
  return reports;
}

describe('WatchActivity', () => {
  it('reports the start, then once every 60 seconds while it plays', () => {
    const reports = play(new WatchActivity(), 0, 181, T0);
    expect(reports.map((r) => r.second)).toEqual([0, 60, 120, 180]);
    expect(reports.every((r) => r.state === 'PLAYING')).toBe(true);
  });

  it('carries what Amazon asks for: content, state, position, duration and the credits', () => {
    expect(new WatchActivity().next(film('PLAYING', 12_000), T0)).toEqual({
      contentId: 'big-buck-bunny',
      state: 'PLAYING',
      positionMs: 12_000,
      durationMs: 596_000,
      creditsPositionMs: 580_000,
    });
  });

  it('reports a pause and the play after it, at once', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 0), T0);
    a.next(film('PLAYING', 1000), T0 + 1000);
    expect(a.next(film('PAUSED', 1500), T0 + 2000)?.state).toBe('PAUSED');
    expect(a.next(film('PAUSED', 1500), T0 + 3000)).toBeUndefined();
    expect(a.next(film('PLAYING', 1500), T0 + 9000)?.state).toBe('PLAYING');
  });

  it('keeps reporting every 60 seconds while paused — "regardless of playback state"', () => {
    const a = new WatchActivity();
    a.next(film('PAUSED', 5000), T0);
    expect(a.next(film('PAUSED', 5000), T0 + REPORT_EVERY_MS - 1000)).toBeUndefined();
    expect(a.next(film('PAUSED', 5000), T0 + REPORT_EVERY_MS)?.state).toBe('PAUSED');
  });

  it('reports a seek: her 30-second skip forward, back, and "start over"', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 100_000), T0);
    expect(a.next(film('PLAYING', 101_000), T0 + 1000)).toBeUndefined();
    expect(a.next(film('PLAYING', 132_000), T0 + 2000)?.positionMs).toBe(132_000);
    expect(a.next(film('PLAYING', 103_000), T0 + 3000)?.positionMs).toBe(103_000);
    expect(a.next(film('PLAYING', 0), T0 + 4000)?.positionMs).toBe(0);
  });

  it('does not take a snapshot that arrived a little late for a seek', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 100_000), T0);
    expect(a.next(film('PLAYING', 102_400), T0 + 1000)).toBeUndefined();
  });

  it('says EXIT when she leaves the film or it ends — never PAUSE for leaving (Amazon: "Do not send a PAUSE event when exiting content")', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 40_000), T0);
    expect(a.next(film('STOPPED', 41_000), T0 + 1000)).toMatchObject({ state: 'EXIT', positionMs: 41_000 });
  });

  it('ignores buffering: it is not a state the platform has, nor a change', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 0), T0);
    expect(a.next(film('BUFFERING', 1000), T0 + 1000)).toBeUndefined();
    expect(a.next(film('PLAYING', 2000), T0 + 2000)).toBeUndefined();
  });

  it('reports a different film at once, and starts afresh after reset', () => {
    const a = new WatchActivity();
    a.next(film('PLAYING', 0), T0);
    expect(a.next(film('PLAYING', 1000, 'sintel'), T0 + 1000)?.contentId).toBe('sintel');
    a.reset();
    expect(a.next(film('PLAYING', 2000, 'sintel'), T0 + 2000)).toBeDefined();
  });
});
