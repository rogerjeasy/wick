/**
 * The report itself (report.ts): the event is built with the SDK's own
 * builders, carries every field Amazon marks required, and reaches
 * ContentPersonalizationServer.reportNewPlaybackEvent in order. A failing
 * platform never stops the film.
 *
 * The SDK cannot load outside a Vega runtime (its TurboModule lookup runs
 * at import), so the builders here are stand-ins with the SDK's own
 * contract: `buildActiveEvent()` throws when a required field is missing,
 * as the .d.ts says it does.
 */
import { describe, expect, it, vi } from 'vitest';
import { CONTENT_ID_NAMESPACE, PROFILE_ID, PROFILE_ID_NAMESPACE, platformPlaybackReporter, toPlaybackEvent } from '../report.js';
import type { WatchReport } from '../watchActivity.js';

class IdBuilder {
  #id = '';
  #ns = '';
  id(v: string) { this.#id = v; return this; }
  idNamespace(v: string) { this.#ns = v; return this; }
  build() { return { id: this.#id, idNamespace: this.#ns }; }
}

class PlaybackEventBuilder {
  readonly fields: Record<string, unknown> = {};
  #set(k: string, v: unknown) { this.fields[k] = v; return this; }
  contentId(v: unknown) { return this.#set('contentId', v); }
  profileId(v: unknown) { return this.#set('profileId', v); }
  playbackPositionMs(v: number) { return this.#set('playbackPositionMs', v); }
  playbackState(v: number) { return this.#set('playbackState', v); }
  durationMs(v: number) { return this.#set('durationMs', v); }
  creditsPositionMs(v: number) { return this.#set('creditsPositionMs', v); }
  buildActiveEvent() {
    for (const required of ['contentId', 'playbackPositionMs', 'playbackState']) {
      if (!(required in this.fields)) throw new Error(`InvalidArgumentError: ${required}`);
    }
    return { ...this.fields };
  }
}

const PlaybackState = { PLAYING: 0, PAUSED: 1, EXIT: 2, INTERSTITIAL: 3 };
const builders = { ContentIdBuilder: IdBuilder, ProfileIdBuilder: IdBuilder, PlaybackEventBuilder, PlaybackState } as never;

const report = (over: Partial<WatchReport> = {}): WatchReport => ({
  contentId: 'big-buck-bunny',
  state: 'PLAYING',
  positionMs: 89_770,
  durationMs: 596_000,
  ...over,
});

describe('toPlaybackEvent', () => {
  it('carries every field Amazon marks required for Watch Activity', () => {
    expect(toPlaybackEvent(report({ creditsPositionMs: 580_000 }), builders)).toEqual({
      contentId: { id: 'big-buck-bunny', idNamespace: 'cdf_id' },
      profileId: { id: PROFILE_ID, idNamespace: 'app_internal' },
      playbackPositionMs: 89_770,
      playbackState: 0,
      durationMs: 596_000,
      creditsPositionMs: 580_000,
    });
    expect(CONTENT_ID_NAMESPACE).toBe('cdf_id');
    expect(PROFILE_ID_NAMESPACE).toBe('app_internal');
  });

  it('maps her three states to the platform’s', () => {
    expect(toPlaybackEvent(report({ state: 'PAUSED' }), builders)).toMatchObject({ playbackState: 1 });
    expect(toPlaybackEvent(report({ state: 'EXIT' }), builders)).toMatchObject({ playbackState: 2 });
  });

  it('names nobody: the profile is a constant', () => {
    expect(PROFILE_ID).toBe('resident');
  });
});

describe('platformPlaybackReporter', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('hands each event to reportNewPlaybackEvent, in the order they came', async () => {
    const reported: unknown[] = [];
    const reporter = platformPlaybackReporter(async () => ({ ...(builders as object), ContentPersonalizationServer: { reportNewPlaybackEvent: (e: unknown) => reported.push(e) } }) as never);
    reporter(report({ positionMs: 0 }));
    reporter(report({ state: 'PAUSED', positionMs: 1000 }));
    reporter(report({ state: 'EXIT', positionMs: 2000 }));
    await flush();
    expect(reported.map((e) => (e as { playbackPositionMs: number }).playbackPositionMs)).toEqual([0, 1000, 2000]);
  });

  it('on a platform without Content Personalization (the Fire OS build), says so once and reports nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let loads = 0;
    const reporter = platformPlaybackReporter(async () => {
      loads += 1;
      return {};
    });
    for (let i = 0; i < 5; i += 1) reporter(report({ positionMs: i * 1000 }));
    await flush();
    expect(loads).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('a platform that refuses is logged, and the next report still goes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const reporter = platformPlaybackReporter(async () => ({
      ...(builders as object),
      ContentPersonalizationServer: {
        reportNewPlaybackEvent: () => {
          calls += 1;
          if (calls === 1) throw new Error('service unavailable');
        },
      },
    }) as never);
    reporter(report());
    reporter(report({ state: 'PAUSED' }));
    await flush();
    expect(calls).toBe(2);
    expect(error).toHaveBeenCalledWith('playback_report_failed', expect.any(Error));
    error.mockRestore();
  });
});
