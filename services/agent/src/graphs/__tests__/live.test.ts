import { describe, it, expect, vi } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { LiveStartError } from '../../live/bridge.js';
import { LIVE_NODES, runLiveGraph, type LiveGraphDeps } from '../live.js';

const NOW = 1_790_000_000_000;
const queued = {
  id: 'door-abc', urgency: 'DOOR', queuedAt: NOW - 10_000, expiresAt: NOW + 290_000, shownCount: 1,
  card: {
    type: 'DOOR', id: 'door-abc', householdId: 'margaret', correlationId: 'corr', createdAt: NOW - 10_000,
    line: "Someone's at the front door.",
    actions: [{ id: 'watch_live', label: 'Watch live', kind: 'primary' }, { id: 'dismiss', label: 'Not now', kind: 'dismiss' }],
  },
} as QueuedCard;

const deps = (over: Partial<LiveGraphDeps> = {}): LiveGraphDeps => ({
  loadLiveTarget: vi.fn(async () => ({ queued, ringDeviceId: 'cam-1' })),
  now: () => NOW,
  startLive: vi.fn(async () => ({ sessionId: 'sess-1', endsAt: NOW + 60_000 })),
  playlistUrl: (id: string) => `https://live.example/live/${id}/live.m3u8`,
  ...over,
});

describe('live graph (Strands Graph, no model)', () => {
  it('walks gate → start and answers with the playlist the TV will play', async () => {
    const d = deps();
    const run = await runLiveGraph({ householdId: 'margaret', cardId: 'door-abc' }, d);

    expect(run.path).toEqual([LIVE_NODES.gate, LIVE_NODES.start]);
    expect(run.result).toEqual({ sessionId: 'sess-1', playlistUrl: 'https://live.example/live/sess-1/live.m3u8', endsAt: NOW + 60_000 });
    expect(d.startLive).toHaveBeenCalledWith('margaret', 'cam-1');
  });

  it('never reaches the camera when the gate refuses', async () => {
    const d = deps({ loadLiveTarget: vi.fn(async () => undefined) });
    const run = await runLiveGraph({ householdId: 'margaret', cardId: 'door-abc' }, d);

    expect(run.result).toEqual({ error: 'no_such_card' });
    expect(run.path).toEqual([LIVE_NODES.gate]);
    expect(d.startLive).not.toHaveBeenCalled();
  });

  it('says plainly when Ring will not stream', async () => {
    const d = deps({ startLive: vi.fn(async () => { throw new LiveStartError('camera_unavailable'); }) });
    expect((await runLiveGraph({ householdId: 'margaret', cardId: 'door-abc' }, d)).result).toEqual({ error: 'camera_unavailable' });
  });

  it('fails loudly on anything unexpected', async () => {
    const d = deps({ startLive: vi.fn(async () => { throw new Error('ENOSPC'); }) });
    await expect(runLiveGraph({ householdId: 'margaret', cardId: 'door-abc' }, d)).rejects.toThrow(/start/);
  });
});
