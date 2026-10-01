import { describe, it, expect, vi } from 'vitest';
import { RingApiError, RingTokenUnavailable } from '@wick/ring';
import { LiveStartError, startBridge, type BridgeDeps, type Peer } from '../bridge.js';
import { PLAYLIST } from '../hls.js';

const playlist = (...segs: string[]) => ['#EXTM3U', ...segs.flatMap((s) => ['#EXTINF:1.0,', s]), ''].join('\n');

function harness(opts: {
  playlists?: (string | null)[];
  whep?: () => Promise<{ answer: string; sessionUrl: string }>;
  /** ffmpeg outlives the kill until exitFfmpeg() — as one still flushing, or ignoring SIGINT, does. */
  ffmpegLingers?: boolean;
} = {}) {
  let t = 1_000_000;
  const events: string[] = [];
  let endPeer!: () => void;
  const peer: Peer = {
    offer: 'v=0 offer',
    accept: vi.fn(async (answer: string) => { events.push(`accept:${answer}`); }),
    ended: new Promise<void>((r) => { endPeer = r; }),
    close: vi.fn(() => { events.push('peer.close'); }),
  };
  let reads = 0;
  const playlists = opts.playlists ?? [playlist('live0.ts'), playlist('live0.ts', 'live1.ts')];
  let exitFfmpeg!: (code: number) => void;
  const ffmpeg = {
    exited: new Promise<number | null>((r) => { exitFfmpeg = (code) => { events.push('ffmpeg.exit'); r(code); }; }),
    kill: vi.fn(() => {
      events.push('ffmpeg.kill');
      if (!opts.ffmpegLingers) exitFfmpeg(255);
    }),
  };

  const deps: BridgeDeps = {
    openPeer: vi.fn(async () => peer),
    startWhep: vi.fn(opts.whep ?? (async () => ({ answer: 'v=0 answer', sessionUrl: 'https://api/s/1' }))),
    stopWhep: vi.fn(async (url: string) => { events.push(`whep.delete:${url}`); }),
    workdir: {
      create: vi.fn(async (id: string) => `/tmp/live/${id}`),
      write: vi.fn(async () => {}),
      read: vi.fn(async (_dir: string, name: string) => {
        if (name === PLAYLIST) {
          const p = playlists[Math.min(reads++, playlists.length - 1)];
          return p === null || p === undefined ? null : new TextEncoder().encode(p);
        }
        return new TextEncoder().encode(`bytes:${name}`);
      }),
      remove: vi.fn(async () => { events.push('workdir.remove'); }),
    },
    spawnFfmpeg: vi.fn(() => { events.push('ffmpeg.spawn'); return ffmpeg; }),
    publish: {
      put: vi.fn(async (key: string) => { events.push(`put:${key}`); }),
      removePrefix: vi.fn(async (prefix: string) => { events.push(`s3.remove:${prefix}`); }),
    },
    now: () => t,
    sleep: async (ms: number) => { t += ms; await Promise.resolve(); },
    log: () => {},
  };
  return { deps, peer, events, ffmpeg, endPeer: () => endPeer(), exitFfmpeg: (c: number) => exitFfmpeg(c), advance: (ms: number) => { t += ms; } };
}

const req = { sessionId: 's1', maxMs: 2_000, pollMs: 250, ports: { videoPort: 5004, audioPort: 5006 } };

describe('startBridge', () => {
  it('answers once Ring has accepted the offer, with when the session will end', async () => {
    const h = harness();
    const running = await startBridge(req, h.deps);

    expect(h.deps.startWhep).toHaveBeenCalledWith('v=0 offer');
    expect(h.peer.accept).toHaveBeenCalledWith('v=0 answer');
    expect(running.endsAt).toBe(1_000_000 + 2_000);
    running.stop();
    await running.done;
  });

  it('uploads every segment before the playlist that names it', async () => {
    const h = harness();
    const running = await startBridge(req, h.deps);
    await running.done;

    const puts = h.events.filter((e) => e.startsWith('put:'));
    expect(puts.indexOf('put:live/s1/live0.ts')).toBeLessThan(puts.indexOf(`put:live/s1/${PLAYLIST}`));
    expect(puts.lastIndexOf('put:live/s1/live1.ts')).toBeLessThan(puts.lastIndexOf(`put:live/s1/${PLAYLIST}`));
    expect(puts.filter((p) => p === 'put:live/s1/live0.ts')).toHaveLength(1);
  });

  it('serves the playlist uncached and segments briefly cached', async () => {
    const h = harness();
    await (await startBridge(req, h.deps)).done;
    const put = vi.mocked(h.deps.publish.put);
    const playlistPut = put.mock.calls.find((c) => c[0].endsWith(PLAYLIST))!;
    const segmentPut = put.mock.calls.find((c) => c[0].endsWith('.ts'))!;
    expect(playlistPut[2]).toBe('application/vnd.apple.mpegurl');
    expect(playlistPut[3]).toBe('no-cache, no-store');
    expect(segmentPut[2]).toBe('video/mp2t');
  });

  it('ends at Ring\'s limit and cleans everything up: ffmpeg, peer, the Ring session, the published files', async () => {
    const h = harness();
    const end = await (await startBridge(req, h.deps)).done;

    expect(end).toBe('limit');
    expect(h.events).toEqual(expect.arrayContaining(['ffmpeg.kill', 'peer.close', 'whep.delete:https://api/s/1', 's3.remove:live/s1/', 'workdir.remove']));
  });

  it('stops early when the resident presses Back', async () => {
    const h = harness();
    const running = await startBridge({ ...req, maxMs: 60_000 }, h.deps);
    running.stop();
    expect(await running.done).toBe('stopped');
    expect(h.events).toContain('whep.delete:https://api/s/1');
  });

  it('ends when Ring closes the WebRTC connection', async () => {
    const h = harness();
    const running = await startBridge({ ...req, maxMs: 60_000 }, h.deps);
    h.endPeer();
    expect(await running.done).toBe('ring_ended');
  });

  it('ends when ffmpeg dies, rather than serving a frozen picture', async () => {
    const h = harness();
    const running = await startBridge({ ...req, maxMs: 60_000 }, h.deps);
    h.exitFfmpeg(1);
    expect(await running.done).toBe('ffmpeg_exited');
  });

  it('turns an offline camera into camera_unavailable, and leaves nothing running', async () => {
    const h = harness({ whep: async () => { throw new RingApiError(503, null, 'Device is currently offline'); } });

    await expect(startBridge(req, h.deps)).rejects.toMatchObject({ refusal: 'camera_unavailable' });
    expect(h.events).toEqual(expect.arrayContaining(['ffmpeg.kill', 'peer.close', 'workdir.remove']));
    expect(h.deps.stopWhep).not.toHaveBeenCalled();
  });

  it('turns an HEVC-only camera into camera_unsupported', async () => {
    const h = harness({ whep: async () => { throw new RingApiError(400, 'UNSUPPORTED_HEVC_SDP_OFFER', null); } });
    await expect(startBridge(req, h.deps)).rejects.toBeInstanceOf(LiveStartError);
    await expect(startBridge(req, harness({ whep: async () => { throw new RingApiError(400, 'UNSUPPORTED_HEVC_SDP_OFFER', null); } }).deps)).rejects.toMatchObject({ refusal: 'camera_unsupported' });
  });

  it('keeps streaming through a failed upload — the next tick tries again', async () => {
    const h = harness();
    let failed = false;
    h.deps.publish.put = vi.fn(async (key: string) => {
      if (!failed && key.endsWith('live0.ts')) { failed = true; throw new Error('s3 503'); }
      h.events.push(`put:${key}`);
    });
    await (await startBridge(req, h.deps)).done;
    expect(h.events).toContain('put:live/s1/live0.ts');
  });

  it('settles only once ffmpeg has exited: a warm Lambda would thaw with it still holding the RTP ports', async () => {
    const h = harness({ ffmpegLingers: true });
    const running = await startBridge({ ...req, maxMs: 60_000 }, h.deps);
    let settled = false;
    void running.done.then(() => { settled = true; });

    running.stop();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.events).toContain('ffmpeg.kill');
    expect(settled).toBe(false);

    h.exitFfmpeg(255);
    expect(await running.done).toBe('stopped');
  });

  it('rejects a refused start only once ffmpeg has exited, for the same reason', async () => {
    const h = harness({ ffmpegLingers: true, whep: async () => { throw new RingApiError(503, null, 'offline'); } });
    let settled = false;
    const started = startBridge(req, h.deps).catch((err: unknown) => { settled = true; return err; });

    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.events).toContain('ffmpeg.kill');
    expect(settled).toBe(false);

    h.exitFfmpeg(255);
    expect(await started).toBeInstanceOf(LiveStartError);
  });

  it('says why a start was refused — the error\'s name and reason, never its message', async () => {
    const lines: Record<string, unknown>[] = [];
    const h = harness({ whep: async () => { throw new RingTokenUnavailable('expired', 'token expired 1560s ago; secret detail'); } });

    await expect(startBridge(req, { ...h.deps, log: (l) => lines.push(l) })).rejects.toMatchObject({ refusal: 'camera_unavailable' });
    const refused = lines.find((l) => l.msg === 'live_start_refused')!;
    expect(refused).toMatchObject({ err: 'RingTokenUnavailable', reason: 'expired' });
    expect(JSON.stringify(lines)).not.toContain('secret detail');
  });
});
