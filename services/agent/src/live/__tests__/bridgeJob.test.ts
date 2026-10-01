import { describe, it, expect, vi } from 'vitest';
import { LiveStartError, type BridgeEnd, type RunningBridge } from '../bridge.js';
import { runBridgeJob, type BridgeJobDeps } from '../bridgeJob.js';

const NOW = 1_000_000;
const job = { householdId: 'margaret', sessionId: 's1', ringDeviceId: 'cam-1', endsAt: NOW + 60_000 };

function running() {
  let finish!: (e: BridgeEnd) => void;
  const done = new Promise<BridgeEnd>((r) => { finish = r; });
  const bridge: RunningBridge = { sessionId: 's1', endsAt: job.endsAt, stop: vi.fn(() => finish('stopped')), done };
  return { bridge, finish };
}

function deps(over: Partial<BridgeJobDeps> = {}): BridgeJobDeps & { r: ReturnType<typeof running> } {
  const r = running();
  return {
    r,
    start: vi.fn(async () => r.bridge),
    isStopRequested: vi.fn(async () => false),
    release: vi.fn(async () => {}),
    now: () => NOW,
    sleep: async () => { await new Promise((res) => setTimeout(res, 0)); },
    stopPollMs: 2000,
    ...over,
  };
}

describe('runBridgeJob', () => {
  it('streams until Ring\'s deadline — the bridge gets exactly the time left', async () => {
    const d = deps();
    const result = runBridgeJob(job, d);
    await new Promise((r) => setTimeout(r, 5));
    d.r.finish('limit');

    expect(await result).toBe('limit');
    expect(d.start).toHaveBeenCalledWith('s1', 'cam-1', 60_000);
    expect(d.release).toHaveBeenCalledWith('margaret', 's1');
  });

  it('stops when the resident presses Back', async () => {
    const d = deps({ isStopRequested: vi.fn(async () => true) });
    expect(await runBridgeJob(job, d)).toBe('stopped');
    expect(d.r.bridge.stop).toHaveBeenCalled();
    expect(d.release).toHaveBeenCalled();
  });

  it('never starts a session whose deadline has already passed', async () => {
    const d = deps({ now: () => job.endsAt + 1 });
    expect(await runBridgeJob(job, d)).toBe('expired');
    expect(d.start).not.toHaveBeenCalled();
    expect(d.release).toHaveBeenCalledWith('margaret', 's1');
  });

  it('releases the claim when Ring refuses, so the next press can try again', async () => {
    const d = deps({ start: vi.fn(async () => { throw new LiveStartError('camera_unavailable'); }) });
    expect(await runBridgeJob(job, d)).toBe('camera_unavailable');
    expect(d.release).toHaveBeenCalledWith('margaret', 's1');
  });

  it('keeps streaming through a failed stop check', async () => {
    let calls = 0;
    const d = deps({ isStopRequested: vi.fn(async () => { if (++calls === 1) throw new Error('throttled'); return true; }) });
    expect(await runBridgeJob(job, d)).toBe('stopped');
  });
});
