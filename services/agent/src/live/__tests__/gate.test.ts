import { describe, it, expect, vi } from 'vitest';
import { LIVE_CARD_MAX_AGE_MS, type QueuedCard } from '@wick/contracts';
import { gateLiveRequest, type LiveGateDeps } from '../gate.js';

const NOW = 1_790_000_000_000;
const card = (over: { createdAt?: number; expiresAt?: number; actions?: string[]; type?: string } = {}): QueuedCard => ({
  id: 'door-abc',
  urgency: 'DOOR',
  queuedAt: over.createdAt ?? NOW - 20_000,
  expiresAt: over.expiresAt ?? NOW + 280_000,
  shownCount: 1,
  card: {
    type: (over.type ?? 'DOOR') as 'DOOR',
    id: 'door-abc',
    householdId: 'margaret',
    correlationId: 'corr-1',
    createdAt: over.createdAt ?? NOW - 20_000,
    line: "Someone's at the front door.",
    actions: (over.actions ?? ['watch_live', 'dismiss']).map((id) => ({ id, label: id, kind: 'secondary' as const })),
  },
});

const deps = (target: Awaited<ReturnType<LiveGateDeps['loadLiveTarget']>>): LiveGateDeps => ({
  loadLiveTarget: vi.fn(async () => target),
  now: () => NOW,
});

describe('gateLiveRequest', () => {
  it('passes a fresh door card that offered Watch live, with its camera', async () => {
    const out = await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: card(), ringDeviceId: 'cam-1' }));
    expect(out).toEqual({ pass: true, ringDeviceId: 'cam-1', correlationId: 'corr-1', cardId: 'door-abc' });
  });

  it('refuses a card that is not there', async () => {
    expect(await gateLiveRequest({ householdId: 'margaret', cardId: 'x' }, deps(undefined))).toEqual({ pass: false, refusal: 'no_such_card' });
  });

  it('refuses a card that is not a door card, or never offered Watch live', async () => {
    expect((await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: card({ type: 'WEEK' }), ringDeviceId: 'cam-1' })))).toEqual({ pass: false, refusal: 'no_such_card' });
    expect((await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: card({ actions: ['dismiss'] }), ringDeviceId: 'cam-1' })))).toEqual({ pass: false, refusal: 'no_such_card' });
  });

  it(`refuses once the visit is more than ${LIVE_CARD_MAX_AGE_MS / 60_000} minutes old — nobody is plausibly at the door`, async () => {
    const old = card({ createdAt: NOW - LIVE_CARD_MAX_AGE_MS - 1, expiresAt: NOW + 10_000 });
    expect(await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: old, ringDeviceId: 'cam-1' }))).toEqual({ pass: false, refusal: 'card_too_old' });
  });

  it('refuses an expired card', async () => {
    const expired = card({ expiresAt: NOW - 1 });
    expect(await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: expired, ringDeviceId: 'cam-1' }))).toEqual({ pass: false, refusal: 'card_too_old' });
  });

  it('says the camera is unavailable when the card does not name one', async () => {
    expect(await gateLiveRequest({ householdId: 'margaret', cardId: 'door-abc' }, deps({ queued: card() }))).toEqual({ pass: false, refusal: 'camera_unavailable' });
  });
});
