import { describe, expect, it, vi, afterEach } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import {
  onStartCardService,
  onStopCardService,
  __setCardServiceTestDeps,
} from '../CardService.js';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
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

afterEach(async () => {
  await onStopCardService();
  __setCardServiceTestDeps(null);
  vi.useRealTimers();
});

describe('CardService', () => {
  it('does nothing when unpaired (no stored token, and the server has never heard of this device)', async () => {
    const fs = fakeFs();
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => {
        throw new Error('should not be called when unpaired');
      },
      fetchImpl: (async () => new Response('device_not_paired', { status: 404 })) as unknown as typeof fetch,
    });

    await expect(onStartCardService()).resolves.toBeUndefined();
  });

  it('connects and writes an inbound card to the QueueStore', async () => {
    const fs = fakeFs();
    await fs.writeStringToFile(
      '/data/wick-token.json',
      JSON.stringify({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 }),
      'utf8',
    );

    let cardHandler: ((c: QueuedCard) => void) | undefined;
    const sent: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => ({
        state: 'open' as const,
        onCard: (h: (c: QueuedCard) => void) => {
          cardHandler = h;
          return () => undefined;
        },
        onControl: () => () => undefined,
        send: async (e: unknown) => {
          sent.push(e);
        },
        connect: async () => undefined,
        close: () => undefined,
      }),
    });

    await onStartCardService();

    const card: QueuedCard = {
      id: 'c1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'c1', householdId: 'h1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
      queuedAt: 0,
      shownCount: 0,
    };
    cardHandler?.(card);
    // The fire-and-forget store.upsert() chains several awaits internally
    // (exists -> writeStringToFile); a single microtask tick isn't enough to
    // drain it. A macrotask boundary flushes the whole microtask queue first.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const store = new QueueStore(fs);
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(sent).toEqual([{ t: 'card_shown', cardId: 'c1', at: expect.any(Number) }]);
  });

  it('flushes queued outbound events on its poll interval', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    await fs.writeStringToFile(
      '/data/wick-token.json',
      JSON.stringify({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 }),
      'utf8',
    );
    const store = new QueueStore(fs);
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 1 });

    const sent: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => ({
        state: 'open' as const,
        onCard: () => () => undefined,
        onControl: () => () => undefined,
        send: async (e: unknown) => {
          sent.push(e);
        },
        connect: async () => undefined,
        close: () => undefined,
      }),
    });

    await onStartCardService();
    await vi.advanceTimersByTimeAsync(1100);

    expect(sent).toEqual([{ t: 'card_action', cardId: 'c1', action: 'answer', at: 1 }]);
  });
});
