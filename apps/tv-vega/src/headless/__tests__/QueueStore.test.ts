import { describe, expect, it } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path);
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

const doorCard = (id: string): QueuedCard => ({
  id,
  urgency: 'DOOR',
  card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [], line: 'hi' },
  queuedAt: 0,
  shownCount: 0,
});

describe('QueueStore', () => {
  it('starts empty', async () => {
    const store = new QueueStore(fakeFs());
    expect(await store.readAll()).toEqual([]);
    expect(await store.lastSeenCardId()).toBeUndefined();
  });

  it('upserts by id without duplicating', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));

    const all = await store.readAll();
    expect(all.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(await store.lastSeenCardId()).toBe('c2');
  });

  it('applies a Phase 2 patch to the matching DOOR card only', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.applyPatch({ cardId: 'c1', description: 'A courier in a blue jacket.' });

    const [card] = await store.readAll();
    expect(card!.card.type).toBe('DOOR');
    expect((card!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
  });

  it('removes a card by id', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.remove('c1');
    expect(await store.readAll()).toEqual([]);
  });

  it('queues and drains outbound device events', async () => {
    const store = new QueueStore(fakeFs());
    await store.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 2 });

    const drained = await store.drainOutbound();
    expect(drained).toHaveLength(2);
    expect(await store.drainOutbound()).toEqual([]);
  });
});
