import { describe, it, expect, vi } from 'vitest';
import { DOOR_CARD_TTL_MS, type CardPatch, type QueuedCard } from '@wick/contracts';
import { allowedFamily, handleAskFamily, lookRequestItem, type AskFamilyDeps, type LookRequest } from '../askFamily.js';

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
      { id: 'ask_family', label: 'Ask Sarah to look', kind: 'secondary' },
      { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
    ],
  },
  ...over,
});

const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'ask_family', at: NOW };
const sarah = { userId: 'u-sarah', name: 'Sarah Whitfield' };
const tom = { userId: 'u-tom', name: 'Tom' };

function deps(over: Partial<AskFamilyDeps> = {}): AskFamilyDeps {
  return {
    loadCard: vi.fn(async () => doorCard()),
    listFamily: vi.fn(async () => [sarah]),
    claimOnce: vi.fn(async (_r: LookRequest) => true),
    sendPatch: vi.fn(async (_p: CardPatch) => {}),
    now: () => NOW,
    ...over,
  };
}

describe('handleAskFamily — the resident asks someone to look at the door', () => {
  it('files the request, then tells the resident who was asked and takes the button away', async () => {
    const d = deps();

    expect(await handleAskFamily(detail, d)).toBe('asked');

    expect(d.claimOnce).toHaveBeenCalledWith({ householdId: 'margaret', cardId: 'door-abc', askedAt: NOW, expiresAt: NOW + 270_000 });
    expect(vi.mocked(d.sendPatch).mock.calls).toEqual([[{
      cardId: 'door-abc',
      notice: 'Sarah has been asked to look.',
      actions: [
        { id: 'watch_live', label: 'Watch live', kind: 'primary' },
        { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
      ],
    }]]);
  });

  it('says "the family" when more than one person can answer', async () => {
    const d = deps({ listFamily: vi.fn(async () => [sarah, tom]) });

    await handleAskFamily(detail, d);

    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].notice).toBe('The family has been asked to look.');
  });

  it('lasts as long as the door card does when the card carries no clock of its own', async () => {
    const { expiresAt: _dropped, ...withoutClock } = doorCard();
    const d = deps({ loadCard: vi.fn(async () => withoutClock) });

    await handleAskFamily(detail, d);

    expect(vi.mocked(d.claimOnce).mock.calls[0]![0].expiresAt).toBe(NOW - 30_000 + DOOR_CARD_TTL_MS);
  });

  it('leaves every other press alone', async () => {
    const d = deps();

    expect(await handleAskFamily({ ...detail, action: 'hallway_chime' }, d)).toBe('ignored');
    expect(await handleAskFamily({ cardId: 'door-abc' }, d)).toBe('ignored');

    expect(d.loadCard).not.toHaveBeenCalled();
    expect(d.claimOnce).not.toHaveBeenCalled();
  });

  it('refuses a card that is not a door card the household was sent', async () => {
    const d = deps({ loadCard: vi.fn(async () => undefined) });

    expect(await handleAskFamily(detail, d)).toBe('unknown_card');
    expect(d.claimOnce).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('refuses a press for a button the card never offered — a television cannot invent the question', async () => {
    const card = doorCard();
    const withoutButton: QueuedCard = { ...card, card: { ...card.card, actions: card.card.actions.filter((a) => a.id !== 'ask_family') } };
    const d = deps({ loadCard: vi.fn(async () => withoutButton) });

    expect(await handleAskFamily(detail, d)).toBe('not_offered');
    expect(d.claimOnce).not.toHaveBeenCalled();
  });

  it('refuses a door card that has aged out: nobody is asked about a door that is no longer being answered', async () => {
    const d = deps({ loadCard: vi.fn(async () => doorCard({ expiresAt: NOW - 1 })) });

    expect(await handleAskFamily(detail, d)).toBe('stale');
    expect(d.claimOnce).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('asks nobody, and says so, when everyone has left the circle since the card was drawn', async () => {
    const d = deps({ listFamily: vi.fn(async () => []) });

    expect(await handleAskFamily(detail, d)).toBe('nobody');

    expect(d.claimOnce).not.toHaveBeenCalled();
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0]).toMatchObject({
      cardId: 'door-abc',
      notice: 'There is nobody Wick can ask just now.',
    });
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].actions?.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });

  it('asks once: a second press, or a redelivered one, changes nothing', async () => {
    const d = deps({ claimOnce: vi.fn(async () => false) });

    expect(await handleAskFamily(detail, d)).toBe('duplicate');
    expect(d.sendPatch).not.toHaveBeenCalled();
  });
});

describe('lookRequestItem', () => {
  it('is one row per door card, kept for a day and holding no picture', () => {
    const item = lookRequestItem({ householdId: 'margaret', cardId: 'door-abc', askedAt: NOW, expiresAt: NOW + 270_000 });

    expect(item).toEqual({
      pk: { S: 'HH#margaret' },
      sk: { S: 'LOOK#door-abc' },
      cardId: { S: 'door-abc' },
      askedAt: { N: String(NOW) },
      expiresAt: { N: String(NOW + 270_000) },
      ttl: { N: String(Math.floor(NOW / 1000) + 24 * 60 * 60) },
    });
  });
});

describe('allowedFamily', () => {
  const mem = (userId: string, name: string, status: string) => ({ pk: { S: 'HH#margaret' }, sk: { S: `MEM#${userId}` }, name: { S: name }, status: { S: status } });

  it('is the people the resident allowed, and nobody still waiting, declined or removed', () => {
    const rows = [mem('u-sarah', 'Sarah', 'allowed'), mem('u-tom', 'Tom', 'pending'), mem('u-ann', 'Ann', 'removed'), mem('u-bo', 'Bo', 'declined')];

    expect(allowedFamily(rows)).toEqual([{ userId: 'u-sarah', name: 'Sarah' }]);
  });

  it('skips a row it cannot read rather than ask someone with no name', () => {
    expect(allowedFamily([{ sk: { S: 'MEM#u-x' }, status: { S: 'allowed' } }, {}])).toEqual([]);
  });
});
