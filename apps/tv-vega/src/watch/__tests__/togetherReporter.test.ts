import { describe, expect, it } from 'vitest';
import { WATCH_HEARTBEAT_MS } from '@wick/contracts';
import type { PlayerSnapshot } from '../../player/PlayerService.js';
import { TogetherReporter, type Together } from '../togetherReporter.js';

const T0 = 1_790_900_000_000;
const SESSION: Together = { sessionId: 's-1', programmeId: 'sintel', withName: 'Sarah', until: T0 + 3 * 60 * 60_000 };

const snapshot = (state: PlayerSnapshot['state'], positionMs: number, contentId = 'sintel'): PlayerSnapshot => ({
  state,
  positionMs,
  durationMs: 888_000,
  creditsPositionMs: 744_000,
  contentId,
});

describe('TogetherReporter — what the television says about the film, and only that film', () => {
  it('says where the film is the first time it is asked', () => {
    const reporter = new TogetherReporter(SESSION);

    expect(reporter.report(snapshot('PLAYING', 1_000), T0)).toEqual({
      t: 'watch_position',
      sessionId: 's-1',
      state: 'PLAYING',
      positionMs: 1_000,
      contentId: 'sintel',
      at: T0,
    });
  });

  it('says nothing while the film simply plays on', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 1_000), T0);

    expect(reporter.report(snapshot('PLAYING', 2_000), T0 + 1_000)).toBeUndefined();
    expect(reporter.report(snapshot('PLAYING', 3_050), T0 + 2_000)).toBeUndefined();
  });

  it('says so at once when she pauses, and when she plays again', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 1_000), T0);

    expect(reporter.report(snapshot('PAUSED', 2_000), T0 + 1_000)).toMatchObject({ state: 'PAUSED', positionMs: 2_000 });
    expect(reporter.report(snapshot('PAUSED', 2_000), T0 + 2_000)).toBeUndefined();
    expect(reporter.report(snapshot('PLAYING', 2_000), T0 + 9_000)).toMatchObject({ state: 'PLAYING', positionMs: 2_000 });
  });

  it('says so when she skips, forward or back', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 60_000), T0);

    expect(reporter.report(snapshot('PLAYING', 91_000), T0 + 1_000)).toMatchObject({ state: 'PLAYING', positionMs: 91_000 });
    expect(reporter.report(snapshot('PLAYING', 62_000), T0 + 2_000)).toMatchObject({ positionMs: 62_000 });
  });

  it('says so when she skips while paused', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PAUSED', 60_000), T0);

    expect(reporter.report(snapshot('PAUSED', 90_000), T0 + 1_000)).toMatchObject({ state: 'PAUSED', positionMs: 90_000 });
  });

  it('says the television is finding its place, so nobody runs on ahead of her', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 60_000), T0);

    expect(reporter.report(snapshot('BUFFERING', 90_000), T0 + 1_000)).toMatchObject({ state: 'BUFFERING', positionMs: 90_000 });
  });

  it('checks in every few seconds while the film plays, and not while it is paused', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 0), T0);

    expect(reporter.report(snapshot('PLAYING', WATCH_HEARTBEAT_MS - 1_000), T0 + WATCH_HEARTBEAT_MS - 1_000)).toBeUndefined();
    expect(reporter.report(snapshot('PLAYING', WATCH_HEARTBEAT_MS), T0 + WATCH_HEARTBEAT_MS)).toMatchObject({ state: 'PLAYING', positionMs: WATCH_HEARTBEAT_MS });

    reporter.report(snapshot('PAUSED', 6_000), T0 + 6_000);
    expect(reporter.report(snapshot('PAUSED', 6_000), T0 + 60_000)).toBeUndefined();
  });

  it('says so the moment the credits begin, so the question is not late', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 742_000), T0);

    expect(reporter.report(snapshot('PLAYING', 743_000), T0 + 1_000)).toBeUndefined();
    expect(reporter.report(snapshot('PLAYING', 744_000), T0 + 2_000)).toMatchObject({ state: 'PLAYING', positionMs: 744_000 });
    expect(reporter.report(snapshot('PLAYING', 745_000), T0 + 3_000)).toBeUndefined();
  });

  it('never says anything about another film', () => {
    const reporter = new TogetherReporter(SESSION);

    expect(reporter.report(snapshot('PLAYING', 1_000, 'tears-of-steel'), T0)).toBeUndefined();
    expect(reporter.report(snapshot('PAUSED', 5_000, 'tears-of-steel'), T0 + 4_000)).toBeUndefined();
  });

  it('says the film has stopped when she leaves it, once', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 60_000), T0);

    expect(reporter.report(undefined, T0 + 1_000)).toEqual({
      t: 'watch_position', sessionId: 's-1', state: 'STOPPED', positionMs: 60_000, contentId: 'sintel', at: T0 + 1_000,
    });
    expect(reporter.report(undefined, T0 + 2_000)).toBeUndefined();
  });

  it('has nothing to stop if the film was never on', () => {
    expect(new TogetherReporter(SESSION).report(undefined, T0)).toBeUndefined();
  });

  it('says nothing more once she has left the film: coming back to it is hers alone', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 60_000), T0);
    reporter.report(undefined, T0 + 1_000);

    // The same film, chosen again from the home screen, with no new press on "Start the film".
    expect(reporter.report(snapshot('PLAYING', 0), T0 + 30_000)).toBeUndefined();
    expect(reporter.report(snapshot('PAUSED', 5_000), T0 + 35_000)).toBeUndefined();
    expect(reporter.report(undefined, T0 + 40_000)).toBeUndefined();
  });

  it('says nothing at all once the session is over', () => {
    const reporter = new TogetherReporter(SESSION);
    reporter.report(snapshot('PLAYING', 60_000), T0);

    expect(reporter.report(snapshot('PAUSED', 70_000), SESSION.until)).toBeUndefined();
    expect(reporter.report(undefined, SESSION.until + 1)).toBeUndefined();
  });
});
