import { describe, it, expect, vi } from 'vitest';
import type { BridgeEnd, RunningBridge } from '../bridge.js';
import { LiveRegistry } from '../registry.js';

function fakeBridge(sessionId: string) {
  let finish!: (e: BridgeEnd) => void;
  const done = new Promise<BridgeEnd>((r) => { finish = r; });
  const bridge: RunningBridge = { sessionId, endsAt: 99, stop: vi.fn(() => finish('stopped')), done };
  return { bridge, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LiveRegistry', () => {
  it('starts a bridge with a fresh unguessable session id', async () => {
    const reg = new LiveRegistry();
    const start = vi.fn(async (id: string) => fakeBridge(id).bridge);

    const s = await reg.start('margaret', start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(s.sessionId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(s.endsAt).toBe(99);
  });

  it('joins the running stream on a second press — one live view per household', async () => {
    const reg = new LiveRegistry();
    const start = vi.fn(async (id: string) => fakeBridge(id).bridge);

    const a = await reg.start('margaret', start);
    const b = await reg.start('margaret', start);

    expect(b.sessionId).toBe(a.sessionId);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('joins a start that is still in flight rather than racing it', async () => {
    const reg = new LiveRegistry();
    const start = vi.fn(async (id: string) => fakeBridge(id).bridge);
    const [a, b] = await Promise.all([reg.start('margaret', start), reg.start('margaret', start)]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('is busy while a stream runs, and free once it ends — then a new press starts afresh', async () => {
    const reg = new LiveRegistry();
    let f!: ReturnType<typeof fakeBridge>;
    const start = vi.fn(async (id: string) => (f = fakeBridge(id)).bridge);

    const first = await reg.start('margaret', start);
    expect(reg.busy()).toBe(true);

    f.finish('limit');
    await tick();
    expect(reg.busy()).toBe(false);

    const second = await reg.start('margaret', start);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('stops only the session it is asked to stop', async () => {
    const reg = new LiveRegistry();
    let f!: ReturnType<typeof fakeBridge>;
    const s = await reg.start('margaret', async (id) => (f = fakeBridge(id)).bridge);

    expect(reg.stop('margaret', 'not-this-one')).toBe(false);
    expect(f.bridge.stop).not.toHaveBeenCalled();

    expect(reg.stop('margaret', s.sessionId)).toBe(true);
    expect(f.bridge.stop).toHaveBeenCalled();
  });

  it('does not stay stuck after a start that failed', async () => {
    const reg = new LiveRegistry();
    await expect(reg.start('margaret', async () => { throw new Error('camera offline'); })).rejects.toThrow();
    expect(reg.busy()).toBe(false);
    const s = await reg.start('margaret', async (id) => fakeBridge(id).bridge);
    expect(s.sessionId).toBeTruthy();
  });
});
