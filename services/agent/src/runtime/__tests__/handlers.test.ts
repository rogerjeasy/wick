import { describe, it, expect, vi } from 'vitest';
import type { CardActionDeps } from '../../agents/door/actions.js';
import { doorActionHandler, doorDescribeHandler, liveStartHandler, liveStopHandler } from '../handlers.js';
import { ScriptedModel } from '../../graphs/__tests__/scriptedModel.js';
import type { LiveGraphDeps } from '../../graphs/live.js';

const NOW = 1_790_000_000_000;
const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: NOW };

const deps = (): CardActionDeps => ({
  loadCard: vi.fn(async () => undefined),
  claimOnce: vi.fn(async () => true),
  listDevices: vi.fn(async () => []),
  ringChime: vi.fn(async () => 'rang' as const),
  sendPatch: vi.fn(async () => {}),
  now: () => NOW,
});

describe('doorActionHandler', () => {
  it('runs the door-action graph for the session\'s household', async () => {
    const d = deps();
    const depsFor = vi.fn(() => d);
    const out = await doorActionHandler(depsFor)({ kind: 'door.action', householdId: 'margaret', detail }, { sessionId: 's' });

    expect(depsFor).toHaveBeenCalledWith('margaret');
    expect(d.loadCard).toHaveBeenCalledWith('margaret', 'door-abc');
    expect(out).toEqual({ result: 'unknown_card', path: ['gate'] });
  });

  it('refuses a press for another household — a session only ever acts on its own cards', async () => {
    const depsFor = vi.fn(deps);
    const out = await doorActionHandler(depsFor)({ kind: 'door.action', householdId: 'margaret', detail: { ...detail, householdId: 'someone-else' } }, { sessionId: 's' });

    expect(out).toEqual({ result: 'ignored', path: [] });
    expect(depsFor).not.toHaveBeenCalled();
  });

  it('refuses a payload without a detail', async () => {
    expect(await doorActionHandler(vi.fn(deps))({ kind: 'door.action', householdId: 'margaret' }, { sessionId: 's' }))
      .toEqual({ result: 'ignored', path: [] });
  });
});

describe('liveStartHandler', () => {
  const liveDeps = (): LiveGraphDeps => ({
    loadLiveTarget: vi.fn(async () => undefined),
    now: () => NOW,
    startLive: vi.fn(),
    playlistUrl: (id) => id,
  });

  it('runs the live graph for the session household and answers with its result', async () => {
    const d = liveDeps();
    const out = await liveStartHandler(() => d)({ kind: 'live.start', householdId: 'margaret', cardId: 'door-abc' }, { sessionId: 's' });
    expect(d.loadLiveTarget).toHaveBeenCalledWith('margaret', 'door-abc');
    expect(out).toEqual({ error: 'no_such_card' });
  });

  it('refuses a payload without a card id', async () => {
    expect(await liveStartHandler(liveDeps)({ kind: 'live.start', householdId: 'margaret' }, { sessionId: 's' })).toEqual({ error: 'bad_request' });
  });
});

describe('liveStopHandler', () => {
  it('flags the household\'s session to stop — the bridge Lambda polls for it', async () => {
    const requestStop = vi.fn(async () => true);
    expect(await liveStopHandler(requestStop)({ kind: 'live.stop', householdId: 'margaret', sessionId: 'abc' }, { sessionId: 's' })).toEqual({ stopped: true });
    expect(requestStop).toHaveBeenCalledWith('margaret', 'abc');
  });

  it('answers stopped: false for a malformed stop, without touching the store', async () => {
    const requestStop = vi.fn(async () => true);
    expect(await liveStopHandler(requestStop)({ kind: 'live.stop', householdId: 'margaret' }, { sessionId: 's' })).toEqual({ stopped: false });
    expect(requestStop).not.toHaveBeenCalled();
  });
});

describe('doorDescribeHandler', () => {
  it('decodes the frame and answers with what the describe graph decided', async () => {
    const model = new ScriptedModel('PERSON: no\nAn empty doorstep with a box beside the mat.');
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64');

    const out = (await doorDescribeHandler(() => model)({ kind: 'door.describe', householdId: 'margaret', frame }, { sessionId: 's' })) as { candidate: unknown; reason: string };

    expect(out.candidate).toEqual({ description: 'An empty doorstep with a box beside the mat.', personVisible: false });
    expect(out.reason).toBe('ok');
    const image = model.seen[0]!.flatMap((m) => m.content).find((b) => b.type === 'imageBlock') as { source: { bytes: Uint8Array } };
    expect([...image.source.bytes]).toEqual([0xff, 0xd8, 0xff, 0x01]);
  });

  it('declines without asking the model when there is no frame', async () => {
    const model = new ScriptedModel('x');
    expect(await doorDescribeHandler(() => model)({ kind: 'door.describe', householdId: 'margaret' }, { sessionId: 's' }))
      .toMatchObject({ candidate: null, reason: 'no frame' });
    expect(model.seen).toHaveLength(0);
  });
});
