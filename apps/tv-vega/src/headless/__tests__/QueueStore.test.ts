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

  it('lastSeenCardId is a high-water mark that survives remove()', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));
    await store.remove('c2');

    // The queue now only contains c1, but the device has already seen c2 —
    // reconcile must not redeliver it on the next reconnect.
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(await store.lastSeenCardId()).toBe('c2');
  });

  it('queues and drains outbound device events', async () => {
    const store = new QueueStore(fakeFs());
    await store.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 2 });

    const drained = await store.drainOutbound();
    expect(drained).toHaveLength(2);
    expect(await store.drainOutbound()).toEqual([]);
  });

  it('restores what a previous launch persisted, when the disk works', async () => {
    const fs = fakeFs();
    const first = new QueueStore(fs);
    await first.upsert(doorCard('c1'));
    await first.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });

    const second = new QueueStore(fs);
    expect((await second.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(await second.lastSeenCardId()).toBe('c1');
    expect(await second.drainOutbound()).toHaveLength(1);
  });

  it('drains outbound events another process appended after this store loaded (RhythmSyncTask)', async () => {
    const fs = fakeFs();
    const holder = new QueueStore(fs);
    await holder.drainOutbound(); // loaded, empty

    await new QueueStore(fs).enqueueOutbound({ t: 'app_lifecycle', state: 'fg', at: 5 });

    expect(await holder.drainOutbound()).toEqual([{ t: 'app_lifecycle', state: 'fg', at: 5 }]);
    expect(await holder.drainOutbound()).toEqual([]);
  });

  describe('when every disk call throws — FL-013, the VVD never provisions a data root', () => {
    // The exact rejection observed on-device: a bare IoError, no detail.
    function brokenFs(): FileSystemLike {
      const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
      return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
    }

    it('still holds every card it was given, in memory', async () => {
      const store = new QueueStore(brokenFs());
      await store.upsert(doorCard('c1'));
      await store.upsert(doorCard('c2'));
      await store.applyPatch({ cardId: 'c1', description: 'A courier in a blue jacket.' });
      await store.remove('c2');

      const all = await store.readAll();
      expect(all.map((c) => c.id)).toEqual(['c1']);
      expect((all[0]!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
      expect(await store.lastSeenCardId()).toBe('c2');
    });

    it('still queues and drains outbound device events', async () => {
      const store = new QueueStore(brokenFs());
      await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 2 });

      expect(await store.drainOutbound()).toEqual([{ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 2 }]);
      expect(await store.drainOutbound()).toEqual([]);
    });
  });
});
