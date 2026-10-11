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

  const pairedFs = async (): Promise<FileSystemLike> => {
    const fs = fakeFs();
    await fs.writeStringToFile(
      '/data/wick-token.json',
      JSON.stringify({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 }),
      'utf8',
    );
    return fs;
  };

  const doorCard: QueuedCard = {
    id: 'c1',
    urgency: 'DOOR',
    card: { type: 'DOOR', id: 'c1', householdId: 'h1', correlationId: 'x', createdAt: 0, actions: [], line: "Someone's at the front door." },
    queuedAt: 0,
    shownCount: 0,
  };

  /** A channel that hands the test its card handler and records what is sent on it. */
  function listeningChannel() {
    const sent: unknown[] = [];
    const asked: unknown[] = [];
    let cardHandler: ((c: QueuedCard) => void) | undefined;
    const createChannel = async (config: unknown) => {
      asked.push(config);
      return {
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
      };
    };
    return { sent, asked, createChannel, push: (c: QueuedCard) => cardHandler?.(c) };
  }

  // The fire-and-forget store.upsert() chains several awaits internally; a
  // macrotask boundary flushes the whole microtask queue first.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('holds the background connection, and puts up a toast for a door card', async () => {
    const fs = await pairedFs();
    const channel = listeningChannel();
    const toasts: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: channel.createChannel,
      postToast: async (toast) => {
        toasts.push(toast);
      },
    });

    await onStartCardService();
    await settle();
    channel.push(doorCard);
    await settle();

    expect(channel.asked).toEqual([{ websocket: { url: 'wss://ws.example', role: 'background' } }]);
    expect(toasts).toEqual([expect.objectContaining({ mTitle: "Someone's at the front door." })]);
  });

  it('keeps the card for the app, and does not say it was shown — it has not been', async () => {
    const fs = await pairedFs();
    const channel = listeningChannel();
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: channel.createChannel,
      postToast: async () => undefined,
    });

    await onStartCardService();
    await settle();
    channel.push(doorCard);
    await settle();

    expect((await new QueueStore(fs).readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(channel.sent).toEqual([]);
  });

  it('puts up nothing for a note from family — it waits for a natural break', async () => {
    const fs = await pairedFs();
    const channel = listeningChannel();
    const toasts: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: channel.createChannel,
      postToast: async (toast) => {
        toasts.push(toast);
      },
    });

    await onStartCardService();
    await settle();
    channel.push({
      id: 'n1',
      urgency: 'DEFERRED',
      card: { type: 'MESSAGE', id: 'n1', householdId: 'h1', correlationId: 'x', createdAt: 0, actions: [], fromName: 'Sarah', suggestedReplies: [] },
      queuedAt: 0,
      shownCount: 0,
    });
    await settle();

    expect(toasts).toEqual([]);
  });
});
