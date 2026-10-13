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
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
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
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
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

  // A family member's own television (packages/contracts/src/familyTelevision.ts)
  // has no card channel at all: nothing of the resident's is sent to it.
  // What its service does instead is ask the Wick server what waits for
  // that member, and say so in a toast (headless/waitingService.ts).
  describe("on a family member's own television", () => {
    const CONFIG = { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' };
    const family = { jwt: 'full-jwt', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000, kind: 'family' };
    const narrow = { ...family, jwt: 'narrow-jwt', scope: 'waiting' };
    const neverAChannel = vi.fn(async () => {
      throw new Error("the card channel must never be opened with a family television's token");
    });

    interface Asked {
      readonly url: string;
      readonly authorization: string | undefined;
      readonly body: unknown;
    }
    /** The pairing service and the Wick server behind one fetch, each answered by the test. */
    function network(answer: (asked: Asked) => Response) {
      const asked: Asked[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        const one = { url, authorization: headers.authorization, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
        asked.push(one);
        return answer(one);
      }) as unknown as typeof fetch;
      return { asked, fetchImpl };
    }
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });
    const WAITS = { waiting: [{ id: 'ftv-door_look-d1', line: 'Margaret asks who is at her door.' }] };

    it('holds no connection, from a stored token or one it is given: it asks what waits, and says it in a toast', async () => {
      const stored = fakeFs();
      await stored.writeStringToFile('/data/wick-token.json', JSON.stringify(family), 'utf8');
      const net = network(() => json(200, WAITS));
      const toasts: unknown[] = [];
      __setCardServiceTestDeps({ fs: stored, config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl, postToast: async (toast) => void toasts.push(toast) });

      await onStartCardService();
      await settle();

      expect(neverAChannel).not.toHaveBeenCalled();
      expect(net.asked).toEqual([{ url: 'https://wick.example/tv/waiting', authorization: 'Bearer full-jwt', body: undefined }]);
      expect(toasts).toEqual([expect.objectContaining({ mTitle: 'Margaret asks who is at her door.', mDescription: 'Open Wick to answer.' })]);
    });

    it('where the disk keeps nothing, takes the narrow token the app opened the way for — and never writes it down', async () => {
      const fs = fakeFs();
      // Its own id: what was said once in this process is not said again, in the tests as on the television.
      const net = network((asked) => (asked.url.endsWith('/pair/refresh') ? json(200, { token: narrow }) : json(200, { waiting: [{ id: 'ftv-wave-back-1', line: 'Margaret waved back.' }] })));
      const toasts: unknown[] = [];
      __setCardServiceTestDeps({ fs, config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl, postToast: async (toast) => void toasts.push(toast) });

      await onStartCardService();
      await settle();

      expect(net.asked).toEqual([
        // Without a token, and saying it is the service: answered only inside the way the app opened.
        { url: 'https://pair.example/pair/refresh', authorization: undefined, body: { deviceId: expect.any(String), forService: true } },
        { url: 'https://wick.example/tv/waiting', authorization: 'Bearer narrow-jwt', body: undefined },
      ]);
      expect(toasts).toHaveLength(1);
      expect(await fs.exists('/data/wick-token.json')).toBe(false);
      expect(neverAChannel).not.toHaveBeenCalled();
    });

    it('says each thing once, however often the service is stopped and started in one process', async () => {
      const stored = fakeFs();
      await stored.writeStringToFile('/data/wick-token.json', JSON.stringify(family), 'utf8');
      const net = network(() => json(200, { waiting: [{ id: 'ftv-reach-once', line: 'Margaret would like you to ring her.' }] }));
      const toasts: unknown[] = [];
      __setCardServiceTestDeps({ fs: stored, config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl, postToast: async (toast) => void toasts.push(toast) });

      await onStartCardService();
      await settle();
      await onStopCardService();
      await onStartCardService();
      await settle();

      expect(net.asked.filter((a) => a.url.endsWith('/tv/waiting'))).toHaveLength(2);
      expect(toasts).toHaveLength(1);
    });

    it('when the way is not open, waits for it: it knocks again, and takes up when it is let in', async () => {
      vi.useFakeTimers();
      let open = false;
      const net = network((asked) => {
        if (asked.url.endsWith('/pair/refresh')) return open ? json(200, { token: narrow }) : new Response('token_required', { status: 401 });
        return json(200, { waiting: [] });
      });
      __setCardServiceTestDeps({ fs: fakeFs(), config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl });

      await onStartCardService();
      await vi.advanceTimersByTimeAsync(0);
      // Refused at the start, and once more straight away as the first knock.
      expect(net.asked.map((a) => a.url)).toEqual(['https://pair.example/pair/refresh', 'https://pair.example/pair/refresh']);

      open = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(net.asked.at(-1)).toEqual({ url: 'https://wick.example/tv/waiting', authorization: 'Bearer narrow-jwt', body: undefined });
      for (const knock of net.asked.filter((a) => a.url.endsWith('/pair/refresh'))) {
        expect(knock).toEqual({ url: 'https://pair.example/pair/refresh', authorization: undefined, body: { deviceId: expect.any(String), forService: true } });
      }
    });

    it('asks nothing more once it is stopped', async () => {
      vi.useFakeTimers();
      const stored = fakeFs();
      await stored.writeStringToFile('/data/wick-token.json', JSON.stringify(family), 'utf8');
      const net = network(() => json(200, { waiting: [] }));
      __setCardServiceTestDeps({ fs: stored, config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl });

      await onStartCardService();
      await vi.advanceTimersByTimeAsync(0);
      await onStopCardService();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(net.asked).toHaveLength(1);
    });

    it('renews a refused token with that token as its proof, and writes nothing down: the file is the app’s', async () => {
      const stored = fakeFs();
      await stored.writeStringToFile('/data/wick-token.json', JSON.stringify(family), 'utf8');
      let refused = false;
      const net = network((asked) => {
        if (asked.url.endsWith('/pair/refresh')) return json(200, { token: { ...family, jwt: 'full-2' } });
        if (!refused) {
          refused = true;
          return json(401, {});
        }
        return json(200, { waiting: [] });
      });
      __setCardServiceTestDeps({ fs: stored, config: CONFIG, createChannel: neverAChannel, fetchImpl: net.fetchImpl });

      await onStartCardService();
      await settle();
      await settle();

      expect(net.asked.map((a) => [a.url, a.authorization])).toEqual([
        ['https://wick.example/tv/waiting', 'Bearer full-jwt'],
        ['https://pair.example/pair/refresh', 'Bearer full-jwt'],
        ['https://wick.example/tv/waiting', 'Bearer full-2'],
      ]);
      expect(JSON.parse(await stored.readFileAsString('/data/wick-token.json', 'utf8'))).toEqual(family);
    });
  });

  it("does nothing on a television nobody has connected, even now that a family one's service waits", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response('device_not_paired', { status: 404 }));
    __setCardServiceTestDeps({
      fs: fakeFs(),
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
      createChannel: async () => {
        throw new Error('should not be called when unpaired');
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await onStartCardService();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Seen on the Vega simulator, 2026-10-11. Opening Wick already paired, the
  // app refreshes its token and starts this service, which asks for the same
  // refresh a second later and is told "too soon" (one in 30 seconds). And
  // the system ends a service whose start has not returned in 8 seconds
  // ("START transition timed out … AppNotResponding"). So the wait has to
  // happen after the start has returned.
  it('starts at once when the server says "too soon", and holds the connection once it has its token', async () => {
    vi.useFakeTimers();
    const channel = listeningChannel();
    const token = { jwt: 'j', deviceId: 'wick-tv', householdId: 'h1', expiresAt: Date.now() + 3_600_000 };
    const answers = [
      new Response('refresh_rate_limited', { status: 429 }),
      new Response(JSON.stringify({ token }), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    __setCardServiceTestDeps({
      fs: fakeFs(),
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
      createChannel: channel.createChannel,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let started = false;
    void onStartCardService().then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(started).toBe(true);
    expect(channel.asked).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(channel.asked).toEqual([{ websocket: { url: 'wss://ws.example', role: 'background' } }]);
  });

  it('holds nothing if it was stopped while it waited for its token', async () => {
    vi.useFakeTimers();
    const channel = listeningChannel();
    const token = { jwt: 'j', deviceId: 'wick-tv', householdId: 'h1', expiresAt: Date.now() + 3_600_000 };
    const answers = [
      new Response('refresh_rate_limited', { status: 429 }),
      new Response(JSON.stringify({ token }), { status: 200 }),
    ];
    __setCardServiceTestDeps({
      fs: fakeFs(),
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
      createChannel: channel.createChannel,
      fetchImpl: (async () => answers.shift()!) as unknown as typeof fetch,
    });

    void onStartCardService();
    await vi.advanceTimersByTimeAsync(4_000);
    await onStopCardService();
    await vi.advanceTimersByTimeAsync(40_000);

    expect(channel.asked).toEqual([]);
  });

  it('keeps the card for the app, and does not say it was shown — it has not been', async () => {
    const fs = await pairedFs();
    const channel = listeningChannel();
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
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
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' },
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
