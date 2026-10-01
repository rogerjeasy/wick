import { describe, it, expect, vi } from 'vitest';
import type { CardPatch, QueuedCard } from '@wick/contracts';
import type { RingDevice } from '@wick/ring';
import type { CardActionDeps } from '../../agents/door/actions.js';
import { DOOR_ACTION_NODES, runDoorActionGraph } from '../doorAction.js';

const NOW = 1_790_000_000_000;
const queued: QueuedCard = {
  id: 'door-abc',
  urgency: 'DOOR',
  queuedAt: NOW - 30_000,
  expiresAt: NOW + 270_000,
  shownCount: 1,
  card: {
    type: 'DOOR', id: 'door-abc', householdId: 'margaret', correlationId: 'corr', createdAt: NOW - 30_000,
    line: "Someone's at the front door.",
    actions: [
      { id: 'watch_live', label: 'Watch live', kind: 'primary' },
      { id: 'hallway_chime', label: 'Ring the hallway chime', kind: 'secondary' },
      { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
    ],
  },
};
const chime: RingDevice = { id: 'c1', name: 'Hallway', online: true, capabilities: { motion: false, image: false, chime: true } };
const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: NOW };

function deps(over: Partial<CardActionDeps> = {}): CardActionDeps {
  return {
    loadCard: vi.fn(async () => queued),
    claimOnce: vi.fn(async () => true),
    listDevices: vi.fn(async () => [chime]),
    ringChime: vi.fn(async () => 'rang' as const),
    sendPatch: vi.fn(async (_p: CardPatch) => {}),
    now: () => NOW,
    ...over,
  };
}

describe('door-action graph (Strands Graph, no model)', () => {
  it('walks gate → ring → notify and reports what the chime did', async () => {
    const d = deps();
    const run = await runDoorActionGraph(detail, d);

    expect(run.result).toBe('rang');
    expect(run.path).toEqual([DOOR_ACTION_NODES.gate, DOOR_ACTION_NODES.ring, DOOR_ACTION_NODES.notify]);
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0]).toMatchObject({ cardId: 'door-abc', notice: 'The hallway chime rang.' });
  });

  it('stops at the gate for a duplicate press — the ring node never runs', async () => {
    const d = deps({ claimOnce: vi.fn(async () => false) });
    const run = await runDoorActionGraph(detail, d);

    expect(run.result).toBe('duplicate');
    expect(run.path).toEqual([DOOR_ACTION_NODES.gate]);
    expect(d.ringChime).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('surfaces a failed patch rather than reporting success', async () => {
    const d = deps({ sendPatch: vi.fn(async () => { throw new Error('ddb down'); }) });
    await expect(runDoorActionGraph(detail, d)).rejects.toThrow(/notify/);
  });
});
