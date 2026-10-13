import { describe, expect, it, vi, afterEach } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import {
  onStartCardService,
  onStopCardService,
  __setCardServiceTestDeps,
} from '../CardService.js';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';
import { resolveDeviceId } from '../../deviceId.js';

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

  // The family has disconnected the resident's television: the edge refuses
  // it every connection from then on. The service used to go on trying for
  // ever. It asks the pairing service what the refusals mean
  // (pairing/standing.ts), and stops when the answer is "not connected".
  describe("on the resident's television, once the family has disconnected it", () => {
    const CONFIG = { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' };
    const TOKEN_FILE = '/data/wick-token.json';
    const stored = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000_000 };
    const withToken = async (): Promise<FileSystemLike> => {
      const fs = fakeFs();
      await fs.writeStringToFile(TOKEN_FILE, JSON.stringify(stored), 'utf8');
      return fs;
    };
    const refused = () =>
      vi.fn(async () => {
        throw new Error('403 revoked');
      });

    it('stops trying to connect when the pairing service says the television is no longer connected', async () => {
      vi.useFakeTimers();
      const createChannel = refused();
      const fetchImpl = vi.fn(async () => new Response('device_not_paired', { status: 404 }));
      __setCardServiceTestDeps({ fs: await withToken(), config: CONFIG, createChannel, fetchImpl: fetchImpl as unknown as typeof fetch });

      await onStartCardService();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // Refused once; asked once what that meant; and nothing after.
      expect(createChannel).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('asks by the television’s id with the token it holds, and leaves the token file alone: that is the app’s', async () => {
      vi.useFakeTimers();
      const fs = await withToken();
      const asked: Array<{ url: string; authorization: string | undefined }> = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        asked.push({ url, authorization: (init?.headers as Record<string, string> | undefined)?.Authorization });
        return new Response('device_denylisted', { status: 403 });
      }) as unknown as typeof fetch;
      __setCardServiceTestDeps({ fs, config: CONFIG, createChannel: refused(), fetchImpl });

      await onStartCardService();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer j' }]);
      expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(stored);
    });

    it('goes on trying when the pairing service cannot say: no network, the service in trouble, asked too soon', async () => {
      for (const answer of [() => new Response('oops', { status: 503 }), () => new Response('refresh_rate_limited', { status: 429 }), () => Promise.reject(new TypeError('Network request failed'))]) {
        vi.useFakeTimers();
        const createChannel = refused();
        __setCardServiceTestDeps({ fs: await withToken(), config: CONFIG, createChannel, fetchImpl: (async () => answer()) as unknown as typeof fetch });

        await onStartCardService();
        await vi.advanceTimersByTimeAsync(5 * 60_000);

        // Still trying after five minutes, at its usual pace.
        expect(createChannel.mock.calls.length).toBeGreaterThan(8);
        await onStopCardService();
        vi.useRealTimers();
      }
    });

    it('lets go of a connection it held, when that connection is cut and the answer is "not connected"', async () => {
      vi.useFakeTimers();
      const channel = listeningChannel();
      let state: 'open' | 'backoff' = 'open';
      let closed = false;
      const createChannel = vi.fn(async (config: unknown) => {
        const made = await channel.createChannel(config);
        return {
          ...made,
          get state() {
            return state;
          },
          close: () => {
            closed = true;
          },
        };
      });
      const fetchImpl = vi.fn(async () => new Response('device_not_paired', { status: 404 }));
      __setCardServiceTestDeps({ fs: await withToken(), config: CONFIG, createChannel: createChannel as never, fetchImpl: fetchImpl as unknown as typeof fetch });

      await onStartCardService();
      await vi.advanceTimersByTimeAsync(60_000);
      // Held, and open: nobody is asked anything.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(closed).toBe(false);

      state = 'backoff';
      await vi.advanceTimersByTimeAsync(2_000);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(closed).toBe(true);
    });
  });

  // A refreshed token lasts an hour, and the service's token is always a
  // refreshed one: the simulator's disk keeps nothing. Its connection is a
  // WebSocket, which the edge checks only as it opens — so the hour passes
  // unnoticed, until the connection next drops. Every reconnection is then
  // refused for the token having run out, and until Wick was launched again
  // a door card behind another app got no toast.
  // Hours of the channel's once-a-second timers: given more than the usual five seconds on a busy machine.
  describe("on the resident's television, an hour and more behind another app", { timeout: 60_000 }, () => {
    const CONFIG = { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' };
    const TOKEN_FILE = '/data/wick-token.json';
    const T0 = 1_800_000_000_000;
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    type Token = { jwt: string; deviceId: string; householdId: string; expiresAt: number };

    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const nameOf = (token: Token): string => token.jwt.split('.')[2] ?? '?';
    /** A token as the pairing service mints one (edge-device jwt.mjs), good for an hour from `now`, by the service's clock. */
    const mint = (name: string, deviceId: string, now = Date.now()): Token => {
      const iat = Math.floor(now / 1000);
      return { jwt: `${part({ alg: 'RS256' })}.${part({ deviceId, householdId: 'h1', iat, exp: iat + 3600 })}.${name}`, deviceId, householdId: 'h1', expiresAt: now + HOUR };
    };
    /** The Vega simulator's disk (FL-013): every call fails, and nothing is kept. */
    const diskThatKeepsNothing = (): FileSystemLike => {
      const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
      return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
    };

    /** The edge: the pairing service, and the background WebSocket — checked as it opens, and not again. */
    function edge(options: { televisionClockFastBy?: number } = {}) {
      /** The edge's own clock: the television's may be hours out. */
      const now = (): number => Date.now() - (options.televisionClockFastBy ?? 0);
      let answer: 'token' | 'unreachable' | 'not_connected' = 'token';
      let minted = 0;
      const opened: Array<{ token: Token; state: 'open' | 'backoff' | 'closed'; card?: (c: QueuedCard) => void }> = [];
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        if (answer === 'unreachable') throw new TypeError('Network request failed');
        if (answer === 'not_connected') return new Response('device_not_paired', { status: 404 });
        const { deviceId } = JSON.parse(String(init?.body)) as { deviceId: string };
        return new Response(JSON.stringify({ token: mint(`t${(minted += 1)}`, deviceId, now()) }), { status: 200 });
      });
      const createChannel = vi.fn(async (_config: unknown, token: Token) => {
        if (token.expiresAt <= now()) throw new Error('401 invalid_token');
        const connection: (typeof opened)[number] = { token, state: 'open' };
        opened.push(connection);
        return {
          get state() {
            return connection.state;
          },
          onCard: (handler: (c: QueuedCard) => void) => {
            connection.card = handler;
            return () => undefined;
          },
          onControl: () => () => undefined,
          send: async () => undefined,
          connect: async () => undefined,
          close: () => {
            connection.state = 'closed';
          },
        };
      });
      return {
        fetchImpl,
        createChannel,
        says(next: typeof answer): void {
          answer = next;
        },
        /** Each connection the edge let on, by its token's name, and how it stands. */
        connections: (): string[] => opened.map((connection) => `${nameOf(connection.token)} ${connection.state}`),
        /**
         * The connection drops, as a WebSocket does sooner or later. The
         * channel reconnects by itself with the token it was given: back at
         * once if that token is still good, refused for as long as it is not.
         */
        drop(): void {
          for (const connection of opened) {
            if (connection.state === 'open' && connection.token.expiresAt <= now()) connection.state = 'backoff';
          }
        },
        /** A drop the channel takes a few seconds to come back from, with a token that is still good. */
        dropFor(ms: number): void {
          for (const connection of opened.filter((each) => each.state === 'open')) {
            connection.state = 'backoff';
            setTimeout(() => {
              if (connection.state === 'backoff') connection.state = 'open';
            }, ms);
          }
        },
        /** A door card, sent to whichever connection is open. */
        ring(): void {
          opened.find((connection) => connection.state === 'open')?.card?.(doorCard);
        },
      };
    }

    const start = async (the: ReturnType<typeof edge>, fs: FileSystemLike = diskThatKeepsNothing()) => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      const toasts: unknown[] = [];
      __setCardServiceTestDeps({
        fs,
        config: CONFIG,
        createChannel: the.createChannel as never,
        fetchImpl: the.fetchImpl as unknown as typeof fetch,
        postToast: async (toast) => {
          toasts.push(toast);
        },
      });
      await onStartCardService();
      return { toasts };
    };

    it('its connection drops after the hour: refused with the old token, it asks, holds the connection again with the fresh one — and a door card gets its toast', async () => {
      const the = edge();
      const { toasts } = await start(the);
      await vi.advanceTimersByTimeAsync(80 * MINUTE);
      // Open all that while: nobody was asked anything after the launch.
      expect(the.fetchImpl).toHaveBeenCalledTimes(1);
      expect(the.connections()).toEqual(['t1 open']);

      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(the.fetchImpl).toHaveBeenCalledTimes(2);
      expect(the.connections()).toEqual(['t1 closed', 't2 open']);

      the.ring();
      await vi.advanceTimersByTimeAsync(0);
      expect(toasts).toHaveLength(1);
    });

    it('and again an hour later: each fresh token has its own hour', async () => {
      const the = edge();
      await start(the);
      await vi.advanceTimersByTimeAsync(80 * MINUTE);
      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Twenty minutes into the fresh token: a drop is no trouble at all.
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(the.connections()).toEqual(['t1 closed', 't2 open']);

      await vi.advanceTimersByTimeAsync(HOUR);
      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(the.connections()).toEqual(['t1 closed', 't2 closed', 't3 open']);

      // The launch shows no token; each question after it shows the one in use then.
      const shown = the.fetchImpl.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization?.split('.')[2]);
      expect(shown).toEqual([undefined, 't1', 't2']);
    });

    it('a drop while the token has plenty of life: it asks, is told "connected", and nothing changes — the connection comes back by itself', async () => {
      const the = edge();
      await start(the);
      await vi.advanceTimersByTimeAsync(20 * MINUTE);

      the.dropFor(5_000);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(the.fetchImpl).toHaveBeenCalledTimes(2);
      expect(the.connections()).toEqual(['t1 open']);
    });

    // Seen on the Vega simulator: its clock was 6.9 hours out. By that clock
    // the token it is handed at launch has already run out.
    it('on a television whose clock is hours fast, the hour is still an hour: nothing changes mid-hour, and the fresh token is taken after it', async () => {
      const the = edge({ televisionClockFastBy: 6.9 * HOUR });
      await start(the);
      await vi.advanceTimersByTimeAsync(20 * MINUTE);

      the.dropFor(5_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(the.connections()).toEqual(['t1 open']);

      await vi.advanceTimersByTimeAsync(HOUR);
      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);
      // The token that came with the mid-hour answer was not taken; this one is.
      expect(the.connections()).toEqual(['t1 closed', 't3 open']);
    });

    it('the pairing service out of reach when it drops: it goes on trying, lets go of nothing, and takes the fresh token when it can be asked', async () => {
      const the = edge();
      await start(the);
      await vi.advanceTimersByTimeAsync(80 * MINUTE);

      the.says('unreachable');
      the.drop();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(the.connections()).toEqual(['t1 backoff']);

      the.says('token');
      await vi.advanceTimersByTimeAsync(31_000);

      expect(the.connections()).toEqual(['t1 closed', 't2 open']);
    });

    it('disconnected by the family meanwhile: it is told so, lets go, and takes nothing', async () => {
      const the = edge();
      await start(the);
      await vi.advanceTimersByTimeAsync(80 * MINUTE);

      the.says('not_connected');
      the.drop();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);

      expect(the.connections()).toEqual(['t1 closed']);
      // The launch, the one question, and nothing after.
      expect(the.fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never writes the fresh token down, even where the disk keeps one: the file is the app’s', async () => {
      const fs = fakeFs();
      vi.useFakeTimers();
      vi.setSystemTime(T0);
      // Read from the disk, with ten minutes left.
      const stored = { ...mint('on-disk', await resolveDeviceId(fs)), expiresAt: T0 + 10 * MINUTE };
      await fs.writeStringToFile(TOKEN_FILE, JSON.stringify(stored), 'utf8');
      const the = edge();
      await start(the, fs);
      await vi.advanceTimersByTimeAsync(20 * MINUTE);

      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(the.connections()).toEqual(['on-disk closed', 't1 open']);
      expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(stored);
    });

    it('stopped: the connection it holds now is the one let go, whichever token opened it', async () => {
      const the = edge();
      await start(the);
      await vi.advanceTimersByTimeAsync(80 * MINUTE);
      the.drop();
      await vi.advanceTimersByTimeAsync(2_000);

      await onStopCardService();

      expect(the.connections()).toEqual(['t1 closed', 't2 closed']);
    });
  });
});
