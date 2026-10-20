import { describe, it, expect, vi } from 'vitest';
import { describeViaRuntime } from '../describeRemote.js';

describe('describeViaRuntime — Phase 2b runs in the household\'s AgentCore session', () => {
  it('sends the frame base64 as door.describe and returns the graph\'s answer', async () => {
    const answer = { candidate: { description: 'A man holding a parcel.' }, reason: 'ok', elapsedMs: 900 };
    const invoke = vi.fn(async () => answer);

    const out = await describeViaRuntime(invoke, 'margaret')(new Uint8Array([1, 2, 3]));

    expect(invoke).toHaveBeenCalledWith('door.describe', 'margaret', { frame: 'AQID', format: 'jpeg' });
    expect(out).toEqual(answer);
  });

  it('never throws when the runtime fails — Phase 1 stands', async () => {
    const invoke = vi.fn(async () => { throw new Error('agentcore_503'); });
    const out = await describeViaRuntime(invoke, 'margaret')(new Uint8Array([1]));
    expect(out.candidate).toBeNull();
    expect(out.reason).toBe('agentcore: agentcore_503');
  });

  it('treats a malformed answer as no answer', async () => {
    const out = await describeViaRuntime(vi.fn(async () => ({ nope: true })), 'margaret')(new Uint8Array([1]));
    expect(out).toMatchObject({ candidate: null, reason: 'agentcore: malformed answer' });
  });
});
