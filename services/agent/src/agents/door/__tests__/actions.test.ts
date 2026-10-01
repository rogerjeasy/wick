import { describe, it, expect, vi } from 'vitest';
import type { CardPatch, QueuedCard } from '@wick/contracts';
import type { RingDevice } from '@wick/ring';
import { CHIME_NOTICE, handleCardAction, type CardActionDeps } from '../actions.js';

const NOW = 1_790_000_000_000;

const doorCard = (over: Partial<QueuedCard> = {}): QueuedCard => ({
  id: 'door-abc',
  urgency: 'DOOR',
  queuedAt: NOW - 30_000,
  expiresAt: NOW + 270_000,
  shownCount: 1,
  card: {
    type: 'DOOR',
    id: 'door-abc',
    householdId: 'margaret',
    correlationId: 'corr',
    createdAt: NOW - 30_000,
    line: "Someone's at the front door.",
    actions: [
      { id: 'watch_live', label: 'Watch live', kind: 'primary' },
      { id: 'hallway_chime', label: 'Ring the hallway chime', kind: 'secondary' },
      { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
    ],
  },
  ...over,
});

const chime = (id: string): RingDevice => ({ id, name: id, online: true, capabilities: { motion: false, image: false, chime: true } });
const camera: RingDevice = { id: 'cam', name: 'Front Door', online: true, capabilities: { motion: true, image: true, chime: false } };

const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: NOW };

function deps(over: Partial<CardActionDeps> = {}): CardActionDeps {
  return {
    loadCard: vi.fn(async () => doorCard()),
    claimOnce: vi.fn(async () => true),
    listDevices: vi.fn(async () => [camera, chime('c1')]),
    ringChime: vi.fn(async () => 'rang' as const),
    sendPatch: vi.fn(async (_p: CardPatch) => {}),
    now: () => NOW,
    ...over,
  };
}

describe('handleCardAction', () => {
  it('rings, then patches the notice and removes the chime button from the card', async () => {
    const d = deps();

    expect(await handleCardAction(detail, d)).toBe('rang');

    expect(d.ringChime).toHaveBeenCalledWith('c1');
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0]).toEqual({
      cardId: 'door-abc',
      notice: 'The hallway chime rang.',
      actions: [
        { id: 'watch_live', label: 'Watch live', kind: 'primary' },
        { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
      ],
    });
  });

  it('never asks the doorbell camera to chime — only devices that say chime.play', async () => {
    const d = deps();
    await handleCardAction(detail, d);
    expect(d.ringChime).not.toHaveBeenCalledWith('cam');
  });

  it('rings exactly once for a double press or a redelivered event', async () => {
    const d = deps({ claimOnce: vi.fn(async () => false) });
    expect(await handleCardAction(detail, d)).toBe('duplicate');
    expect(d.ringChime).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('never rings for a card that aged out while it sat on screen', async () => {
    const d = deps({ loadCard: vi.fn(async () => doorCard({ expiresAt: NOW - 1 })) });
    expect(await handleCardAction(detail, d)).toBe('stale');
    expect(d.claimOnce).not.toHaveBeenCalled();
    expect(d.ringChime).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('never rings for a card that was not offered the chime button', async () => {
    const noButton = doorCard();
    const card = { ...noButton, card: { ...noButton.card, actions: noButton.card.actions.filter((a) => a.id !== 'hallway_chime') } };
    const d = deps({ loadCard: vi.fn(async () => card) });
    expect(await handleCardAction(detail, d)).toBe('not_offered');
    expect(d.ringChime).not.toHaveBeenCalled();
  });

  it('ignores actions it does not own, malformed details, and cards that are not door cards', async () => {
    expect(await handleCardAction({ ...detail, action: 'dismiss' }, deps())).toBe('ignored');
    expect(await handleCardAction({ householdId: 'x' }, deps())).toBe('ignored');

    const week = { ...doorCard(), card: { type: 'WEEK', id: 'door-abc', householdId: 'margaret', correlationId: 'c', createdAt: 0, isoWeek: 'w', text: 't', actions: [] } } as QueuedCard;
    expect(await handleCardAction(detail, deps({ loadCard: vi.fn(async () => week) }))).toBe('unknown_card');
    expect(await handleCardAction(detail, deps({ loadCard: vi.fn(async () => undefined) }))).toBe('unknown_card');
  });

  it('rings every chime in the house and reports the most useful truth', async () => {
    const ring = vi.fn(async (id: string) => (id === 'c1' ? ('offline' as const) : ('rang' as const)));
    const d = deps({ listDevices: vi.fn(async () => [chime('c1'), chime('c2')]), ringChime: ring });
    expect(await handleCardAction(detail, d)).toBe('rang');
    expect(ring).toHaveBeenCalledTimes(2);
  });

  it('says plainly when the chime is snoozed, and still removes the button', async () => {
    const d = deps({ ringChime: vi.fn(async () => 'snoozed' as const) });
    expect(await handleCardAction(detail, d)).toBe('snoozed');
    const patch = vi.mocked(d.sendPatch).mock.calls[0]![0];
    expect(patch.notice).toBe(CHIME_NOTICE.snoozed);
    expect(patch.actions!.map((a) => a.id)).not.toContain('hallway_chime');
  });

  it('says there is no chime when the household has none any more', async () => {
    const d = deps({ listDevices: vi.fn(async () => [camera]) });
    expect(await handleCardAction(detail, d)).toBe('no_chime');
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].notice).toBe("There's no hallway chime Wick can reach.");
  });

  it('tells the resident the chime did not answer when Ring cannot even list devices', async () => {
    const d = deps({ listDevices: vi.fn(async () => { throw new Error('ring_api_503'); }) });
    expect(await handleCardAction(detail, d)).toBe('failed');
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].notice).toBe("The hallway chime didn't answer.");
  });
});
