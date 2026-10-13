import { describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { PairingFlow } from '../PairingFlow.js';
import type { FileSystemLike } from '../../headless/QueueStore.js';

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

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 };

describe('PairingFlow', () => {
  it('loadToken returns null when nothing is stored', async () => {
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs());
    expect(await flow.loadToken()).toBeNull();
  });

  it('start() posts deviceId and returns the pairing code', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: '123456', url: 'https://pair.example/123456', expiresAt: 1 }), {
        status: 200,
      }),
    );
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), fetchMock as unknown as typeof fetch);

    const result = await flow.start('d1');

    expect(result.code).toBe('123456');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pair.example/pair/start',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('pollUntilBound polls until bound, then persists the token', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      const body = call < 3 ? { status: 'pending' } : { status: 'bound', token: TOKEN };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const fs = fakeFs();
    const flow = new PairingFlow(
      { pairingApiUrl: 'https://pair.example', pollIntervalMs: 1, pollTimeoutMs: 1000 },
      fs,
      fetchMock as unknown as typeof fetch,
    );

    const token = await flow.pollUntilBound('123456');

    expect(token).toEqual(TOKEN);
    expect(await flow.loadToken()).toEqual(TOKEN);
  });

  it('pollUntilBound resolves with the token even when persisting it fails', async () => {
    // Reproduces the on-device symptom: the server confirms the claim
    // (status: 'bound'), but the device's own writeStringToFile rejects
    // (observed on the Vega Virtual Device as a native "Application data
    // root path is not set" error — see FRICTION.md). Losing the on-disk
    // cache means the device re-pairs on next launch, which is recoverable;
    // never reaching 'ready' after a real, server-confirmed claim is not.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'bound', token: TOKEN }), { status: 200 }));
    const fs = fakeFs();
    fs.writeStringToFile = async () => {
      throw new Error('Application data root path is not set.');
    };
    const flow = new PairingFlow(
      { pairingApiUrl: 'https://pair.example', pollIntervalMs: 1, pollTimeoutMs: 1000 },
      fs,
      fetchMock as unknown as typeof fetch,
    );

    await expect(flow.pollUntilBound('123456')).resolves.toEqual(TOKEN);
  });

  it('pollUntilBound throws when the code expires (404)', async () => {
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }));
    const flow = new PairingFlow(
      { pairingApiUrl: 'https://pair.example', pollIntervalMs: 1 },
      fakeFs(),
      fetchMock as unknown as typeof fetch,
    );

    await expect(flow.pollUntilBound('123456')).rejects.toThrow('pairing_code_expired');
  });

  it('clearToken removes a stored token', async () => {
    const fs = fakeFs();
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs);
    await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(TOKEN), 'utf8');

    await flow.clearToken();

    expect(await flow.loadToken()).toBeNull();
  });

  // A family member's own television (packages/contracts/src/familyTelevision.ts):
  // the token says so, and the television must still know it after a
  // relaunch, a refresh and a renewal — or it would come back as the
  // resident's and open her card channel.
  describe("whose television it is — the token's kind", () => {
    const FAMILY: DeviceToken = { ...TOKEN, kind: 'family' };

    it('keeps the kind the pairing poll delivers, and still has it when the token is read back from disk', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'bound', token: FAMILY }), { status: 200 }));
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', pollIntervalMs: 1 }, fakeFs(), fetchMock as unknown as typeof fetch);

      expect((await flow.pollUntilBound('123456')).kind).toBe('family');
      expect((await flow.loadToken())?.kind).toBe('family');
    });

    it('keeps the kind a refresh gives back, and caches it with the token', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: FAMILY }), { status: 200 }));
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), fetchMock as unknown as typeof fetch);

      expect((await flow.loadToken('d1'))?.kind).toBe('family');
      expect(await flow.loadToken()).toEqual(FAMILY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("gives the resident's token no kind at all, from the poll, the disk or a refresh", async () => {
      const poll = vi.fn(async () => new Response(JSON.stringify({ status: 'bound', token: TOKEN }), { status: 200 }));
      const polled = new PairingFlow({ pairingApiUrl: 'https://pair.example', pollIntervalMs: 1 }, fakeFs(), poll as unknown as typeof fetch);
      expect(await polled.pollUntilBound('123456')).not.toHaveProperty('kind');
      expect(await polled.loadToken()).not.toHaveProperty('kind');

      const refresh = vi.fn(async () => new Response(JSON.stringify({ token: TOKEN }), { status: 200 }));
      const refreshed = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), refresh as unknown as typeof fetch);
      expect(await refreshed.loadToken('d1')).not.toHaveProperty('kind');
    });
  });

  // A television already on screen whose token the server no longer takes
  // (family/familyClient.ts): it asks for a fresh one the way it does at
  // launch, and has to tell "you are no longer connected" from "not now".
  describe('renew — a fresh token for a television already on screen', () => {
    const FAMILY: DeviceToken = { ...TOKEN, jwt: 'fresh', kind: 'family' };
    const flowWith = (fetchMock: unknown, fs = fakeFs()) =>
      new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs, fetchMock as typeof fetch);

    it('asks /pair/refresh with the device id alone, hands back the token with its kind, and keeps it', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://pair.example/pair/refresh');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ deviceId: 'd1' });
        return new Response(JSON.stringify({ token: FAMILY }), { status: 200 });
      });
      const flow = flowWith(fetchMock);

      expect(await flow.renew('d1')).toEqual({ token: FAMILY });
      expect(await flow.loadToken()).toEqual(FAMILY);
    });

    it('asks the server even while the disk still holds the token being replaced', async () => {
      const fs = fakeFs();
      await fs.writeStringToFile('/data/wick-token.json', JSON.stringify({ ...TOKEN, kind: 'family' }), 'utf8');
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: FAMILY }), { status: 200 }));

      expect(await flowWith(fetchMock, fs).renew('d1')).toEqual({ token: FAMILY });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('says the television is no longer connected when the server does not know it, or has revoked it', async () => {
      expect(await flowWith(vi.fn(async () => new Response('device_not_paired', { status: 404 }))).renew('d1')).toBe('not_connected');
      expect(await flowWith(vi.fn(async () => new Response('device_denylisted', { status: 403 }))).renew('d1')).toBe('not_connected');
    });

    it('says "not now" — never "not connected" — when it was asked too soon, the server failed, or nothing answered', async () => {
      expect(await flowWith(vi.fn(async () => new Response('refresh_rate_limited', { status: 429 }))).renew('d1')).toBe('try_later');
      expect(await flowWith(vi.fn(async () => new Response('oops', { status: 500 }))).renew('d1')).toBe('try_later');
      expect(await flowWith(vi.fn(async () => { throw new TypeError('Network request failed'); })).renew('d1')).toBe('try_later');
      expect(await flowWith(vi.fn(async () => new Response('not json', { status: 200 }))).renew('d1')).toBe('try_later');
    });

    it('hands the token back even when it cannot be written down', async () => {
      const fs = fakeFs();
      fs.writeStringToFile = async () => {
        throw new Error('Application data root path is not set.');
      };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: FAMILY }), { status: 200 }));

      expect(await flowWith(fetchMock, fs).renew('d1')).toEqual({ token: FAMILY });
    });
  });

  // The edge no longer mints a family television's token from its device id
  // alone (edge-device pair-refresh.mjs): it must show the token it held —
  // one that has run out will do. So every refresh that has a token to hand
  // sends it, and a token that has run out is kept, because it is the proof.
  describe('the token held, shown on every refresh that has one', () => {
    const EXPIRED: DeviceToken = { jwt: 'held-jwt', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() - 1000, kind: 'family' };
    const FRESH: DeviceToken = { jwt: 'fresh-jwt', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 3_600_000, kind: 'family' };
    const TOKEN_FILE = '/data/wick-token.json';

    interface Asked {
      readonly url: string;
      readonly authorization: string | undefined;
      readonly body: unknown;
    }
    /** A pairing API that answers from a list, and remembers what it was asked and with which headers. */
    function api(answers: Array<Response | Error>) {
      const asked: Asked[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        asked.push({ url, authorization: headers.authorization, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
        const next = answers.shift();
        if (next === undefined) throw new Error('no answer left');
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch;
      return { asked, fetchImpl };
    }
    const holding = async (token: DeviceToken | undefined): Promise<FileSystemLike> => {
      const fs = fakeFs();
      if (token) await fs.writeStringToFile(TOKEN_FILE, JSON.stringify(token), 'utf8');
      return fs;
    };
    const ok = (token: DeviceToken): Response => new Response(JSON.stringify({ token }), { status: 200 });
    const flowOn = (fs: FileSystemLike, fetchImpl: typeof fetch, wait?: (ms: number) => Promise<void>) =>
      new PairingFlow({ pairingApiUrl: 'https://pair.example', ...(wait ? { wait } : {}) }, fs, fetchImpl);

    describe('at launch', () => {
      it('shows the token on disk that has run out, with the device id alone in the body, and keeps the fresh one', async () => {
        const fs = await holding(EXPIRED);
        const { asked, fetchImpl } = api([ok(FRESH)]);

        expect(await flowOn(fs, fetchImpl).loadToken('d1')).toEqual(FRESH);
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer held-jwt', body: { deviceId: 'd1' } }]);
        expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(FRESH);
      });

      it('sends no token when the disk holds none: the device id alone, as before', async () => {
        const { asked, fetchImpl } = api([ok(TOKEN)]);

        expect(await flowOn(await holding(undefined), fetchImpl).loadToken('d1')).toEqual(TOKEN);
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: undefined, body: { deviceId: 'd1' } }]);
      });

      it('asks nothing at all while the token on disk is still good', async () => {
        const { asked, fetchImpl } = api([]);
        const good = { ...FRESH };

        expect(await flowOn(await holding(good), fetchImpl).loadToken('d1')).toEqual(good);
        expect(asked).toEqual([]);
      });

      // The Vega simulator keeps nothing (FL-013): a family television there
      // has no token to show after a relaunch, and is paired again.
      it('reads "a token is required" as not paired — once, with no second try, however patient the caller', async () => {
        const waits: number[] = [];
        const { asked, fetchImpl } = api([new Response('token_required', { status: 401 })]);
        const flow = flowOn(await holding(undefined), fetchImpl, async (ms) => void waits.push(ms));

        expect(await flow.loadToken('d1', { waitIfRefreshedJustNow: true })).toBeNull();
        expect(asked).toHaveLength(1);
        expect(waits).toEqual([]);
      });

      it('forgets the token on disk when the server, shown it, says this television is no longer connected', async () => {
        for (const refusal of [new Response('invalid_token', { status: 401 }), new Response('device_denylisted', { status: 403 }), new Response('device_not_paired', { status: 404 })]) {
          const fs = await holding(EXPIRED);
          const { asked, fetchImpl } = api([refusal, new Response('token_required', { status: 401 })]);
          const flow = flowOn(fs, fetchImpl);

          expect(await flow.loadToken('d1')).toBeNull();
          expect(await fs.readFileAsString(TOKEN_FILE, 'utf8')).toBe('');
          // The next launch has nothing to show, and is not paired: it cannot go round again on the old token.
          expect(await flow.loadToken('d1')).toBeNull();
          expect(asked.map((a) => a.authorization)).toEqual(['Bearer held-jwt', undefined]);
        }
      });

      it('keeps the token that has run out when the answer is only "not now": it is the proof for the next refresh', async () => {
        for (const notNow of [new Response('refresh_rate_limited', { status: 429 }), new Response('oops', { status: 500 })]) {
          const fs = await holding(EXPIRED);
          const { asked, fetchImpl } = api([notNow, ok(FRESH)]);
          const flow = flowOn(fs, fetchImpl);

          expect(await flow.loadToken('d1')).toBeNull();
          expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
          expect(await flow.loadToken('d1')).toEqual(FRESH);
          expect(asked.map((a) => a.authorization)).toEqual(['Bearer held-jwt', 'Bearer held-jwt']);
        }
      });

      it('keeps it when nothing answers at all', async () => {
        const fs = await holding(EXPIRED);
        const { fetchImpl } = api([new TypeError('Network request failed')]);

        await expect(flowOn(fs, fetchImpl).loadToken('d1')).rejects.toThrow('Network request failed');
        expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
      });

      it('shows the same token again each time it waits out a "too soon"', async () => {
        const { asked, fetchImpl } = api([new Response('refresh_rate_limited', { status: 429 }), ok(FRESH)]);
        const flow = flowOn(await holding(EXPIRED), fetchImpl, async () => undefined);

        expect(await flow.loadToken('d1', { waitIfRefreshedJustNow: true })).toEqual(FRESH);
        expect(asked.map((a) => a.authorization)).toEqual(['Bearer held-jwt', 'Bearer held-jwt']);
      });

      it('treats a file that holds no token as holding none', async () => {
        const fs = fakeFs();
        await fs.writeStringToFile(TOKEN_FILE, JSON.stringify({ deviceId: 'd1' }), 'utf8');
        const { asked, fetchImpl } = api([ok(TOKEN)]);

        expect(await flowOn(fs, fetchImpl).loadToken('d1')).toEqual(TOKEN);
        expect(asked[0]!.authorization).toBeUndefined();
      });
    });

    describe('renew, on screen', () => {
      it('shows the token the television is holding in memory — the one just refused — whatever the disk holds', async () => {
        const { asked, fetchImpl } = api([ok(FRESH)]);

        expect(await flowOn(await holding(undefined), fetchImpl).renew('d1', 'in-memory-jwt')).toEqual({ token: FRESH });
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer in-memory-jwt', body: { deviceId: 'd1' } }]);
      });

      it('falls back to the token on disk, run out or not, when it is handed none', async () => {
        const { asked, fetchImpl } = api([ok(FRESH)]);

        await flowOn(await holding(EXPIRED), fetchImpl).renew('d1');

        expect(asked[0]!.authorization).toBe('Bearer held-jwt');
      });

      it('says "not connected" on a 401 as on a 403 or a 404, forgets the token, and asks once', async () => {
        for (const refusal of [
          new Response('invalid_token', { status: 401 }),
          new Response('token_required', { status: 401 }),
          new Response('device_denylisted', { status: 403 }),
          new Response('device_not_paired', { status: 404 }),
        ]) {
          const fs = await holding(EXPIRED);
          const { asked, fetchImpl } = api([refusal]);

          expect(await flowOn(fs, fetchImpl).renew('d1', 'held-jwt')).toBe('not_connected');
          expect(asked).toHaveLength(1);
          expect(await fs.readFileAsString(TOKEN_FILE, 'utf8')).toBe('');
        }
      });

      it('keeps the token on disk when the answer is only "not now"', async () => {
        for (const notNow of [new Response('refresh_rate_limited', { status: 429 }), new Response('oops', { status: 500 }), new TypeError('Network request failed')]) {
          const fs = await holding(EXPIRED);
          const { fetchImpl } = api([notNow]);

          expect(await flowOn(fs, fetchImpl).renew('d1', 'held-jwt')).toBe('try_later');
          expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
        }
      });
    });
  });

  describe('clearToken on storage that throws (FRICTION.md FL-013)', () => {
    it('does not throw: a television that cannot forget on disk still goes back to the pairing screen', async () => {
      const fs = fakeFs();
      fs.exists = async () => {
        throw new Error('[com.amazon.kepler.io.IoError]: ');
      };
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs);

      await expect(flow.clearToken()).resolves.toBeUndefined();
    });
  });

  describe('loadToken refresh fallback (FRICTION.md FL-013)', () => {
    // CardService.ts runs in a separate process from App.tsx and only ever
    // calls loadToken(), never start()/pollUntilBound() — on a device where
    // /data can't actually hold a written file, disk alone can never tell it
    // "this device is already paired." The refresh fallback below is what
    // lets it learn that from the server instead, using the same durable
    // deviceId<->householdId binding pair-claim.mjs already writes.

    it('does not call /pair/refresh when no deviceId is given', async () => {
      const fetchMock = vi.fn();
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example' },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to /pair/refresh when disk has nothing and a deviceId is given', async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://pair.example/pair/refresh');
        // INV-8: the device id alone. The server knows which home the television belongs to.
        expect(JSON.parse(String(init?.body))).toEqual({ deviceId: 'd1' });
        return new Response(JSON.stringify({ token: TOKEN }), { status: 200 });
      });
      const fs = fakeFs();
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example' },
        fs,
        fetchMock as unknown as typeof fetch,
      );

      const token = await flow.loadToken('d1');

      expect(token).toEqual(TOKEN);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Best-effort cached for next time, same as pollUntilBound's fix.
      expect(await flow.loadToken('d1')).toEqual(TOKEN);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns null when /pair/refresh reports the device was never paired', async () => {
      const fetchMock = vi.fn(async () => new Response('device_not_paired', { status: 404 }));
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example' },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken('d1')).toBeNull();
    });

    // The server lets one television refresh once in 30 seconds
    // (edge-device pairing-code.mjs). Where the disk keeps nothing, the app
    // and its card service each ask when the app is opened — a second apart
    // — and the card service was the one turned away: it took that for
    // "not paired" and never held its connection, so a door alert outside
    // Wick stopped after the first relaunch (seen on the Vega simulator,
    // 2026-10-11).
    it('waits and asks again when the server says this television refreshed a moment ago, if told it may wait', async () => {
      const answers = [
        new Response('refresh_rate_limited', { status: 429 }),
        new Response(JSON.stringify({ token: TOKEN }), { status: 200 }),
      ];
      const fetchMock = vi.fn(async () => answers.shift()!);
      const waits: number[] = [];
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example', refreshRetryMs: 32_000, wait: async (ms) => void waits.push(ms) },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken('d1', { waitIfRefreshedJustNow: true })).toEqual(TOKEN);
      expect(waits).toEqual([32_000]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not wait unless told it may — the app has a screen to show instead', async () => {
      const fetchMock = vi.fn(async () => new Response('refresh_rate_limited', { status: 429 }));
      const waits: number[] = [];
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example', wait: async (ms) => void waits.push(ms) },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken('d1')).toBeNull();
      expect(waits).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after a few tries, and never waits on a television the server does not know', async () => {
      const limited = vi.fn(async () => new Response('refresh_rate_limited', { status: 429 }));
      const waits: number[] = [];
      const wait = async (ms: number): Promise<void> => void waits.push(ms);
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', wait }, fakeFs(), limited as unknown as typeof fetch);

      expect(await flow.loadToken('d1', { waitIfRefreshedJustNow: true })).toBeNull();
      expect(limited).toHaveBeenCalledTimes(4);
      expect(waits).toHaveLength(3);

      const unknown = vi.fn(async () => new Response('device_not_paired', { status: 404 }));
      const other = new PairingFlow({ pairingApiUrl: 'https://pair.example', wait }, fakeFs(), unknown as unknown as typeof fetch);

      expect(await other.loadToken('d1', { waitIfRefreshedJustNow: true })).toBeNull();
      expect(unknown).toHaveBeenCalledTimes(1);
      expect(waits).toHaveLength(3);
    });

    it('treats a throwing disk read as "nothing cached" and still falls back to refresh', async () => {
      // Reproduces the suspected cause of this session's unexplained
      // background-process SIGABRT crashes: loadToken()'s disk read was
      // the one call in this file FL-013 never wrapped in try/catch.
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ token: TOKEN }), { status: 200 }));
      const fs = fakeFs();
      fs.exists = async () => {
        throw new Error('[com.amazon.kepler.io.IoError]: ');
      };
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example' },
        fs,
        fetchMock as unknown as typeof fetch,
      );

      await expect(flow.loadToken('d1')).resolves.toEqual(TOKEN);
    });
  });
});
