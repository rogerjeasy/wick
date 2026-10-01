import { describe, it, expect, vi } from 'vitest';
import { LIVE_MAX_MS } from '@wick/contracts';
import { startLive, type StartLiveDeps } from '../startLive.js';

const NOW = 1_000_000;

const deps = (over: Partial<StartLiveDeps> = {}): StartLiveDeps => ({
  claim: vi.fn(async (_h: string, sessionId: string, _now: number, endsAt: number) => ({ joined: false, sessionId, endsAt })),
  release: vi.fn(async () => {}),
  invokeBridge: vi.fn(async () => {}),
  newSessionId: () => 'sess-new',
  now: () => NOW,
  ...over,
});

describe('startLive — the graph decides, the bridge Lambda streams', () => {
  it('claims a session and hands it to the bridge Lambda with the camera and the deadline', async () => {
    const d = deps();
    const out = await startLive('margaret', 'cam-1', d);

    expect(out).toEqual({ sessionId: 'sess-new', endsAt: NOW + LIVE_MAX_MS });
    expect(d.invokeBridge).toHaveBeenCalledWith({ householdId: 'margaret', sessionId: 'sess-new', ringDeviceId: 'cam-1', endsAt: NOW + LIVE_MAX_MS });
  });

  it('joins a stream already running, without starting another bridge', async () => {
    const d = deps({ claim: vi.fn(async () => ({ joined: true, sessionId: 'sess-old', endsAt: NOW + 20_000 })) });
    expect(await startLive('margaret', 'cam-1', d)).toEqual({ sessionId: 'sess-old', endsAt: NOW + 20_000 });
    expect(d.invokeBridge).not.toHaveBeenCalled();
  });

  it('gives the claim back and says the camera is unavailable when the bridge cannot be started', async () => {
    const d = deps({ invokeBridge: vi.fn(async () => { throw new Error('TooManyRequests'); }) });
    await expect(startLive('margaret', 'cam-1', d)).rejects.toMatchObject({ refusal: 'camera_unavailable' });
    expect(d.release).toHaveBeenCalledWith('margaret', 'sess-new');
  });
});
