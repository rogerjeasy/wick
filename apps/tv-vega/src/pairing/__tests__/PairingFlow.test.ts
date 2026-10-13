import { describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { PAIRING_REQUEST_TIMEOUT_MS, PairingFlow } from '../PairingFlow.js';
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

    // What waits, said off the screen (Vega): the app cannot hand its
    // background service anything on the television (FL-013), so it opens a
    // short way for it at the pairing service, with its own token — and the
    // service, with no token to show, says that it is the service
    // (edge-device pair-refresh.mjs, the second contained exception).
    describe('for the background service', () => {
      const SCOPED = { ...FRESH, jwt: 'scoped-jwt', scope: 'waiting' } as DeviceToken;

      it('the app opens the way with the token it holds, and keeps nothing of the answer', async () => {
        const fs = await holding(EXPIRED);
        const { asked, fetchImpl } = api([ok(FRESH)]);

        await expect(flowOn(fs, fetchImpl).openServiceWindow('d1', 'in-memory-jwt')).resolves.toBeUndefined();
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer in-memory-jwt', body: { deviceId: 'd1', forService: true } }]);
        // Not a refresh of its own token: what is on disk stays as it was.
        expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
      });

      it('never throws and never forgets the token, whatever the pairing service answers', async () => {
        for (const answer of [new Response('invalid_token', { status: 401 }), new Response('refresh_rate_limited', { status: 429 }), new TypeError('Network request failed')]) {
          const fs = await holding(EXPIRED);
          const { fetchImpl } = api([answer]);

          await expect(flowOn(fs, fetchImpl).openServiceWindow('d1', 'held-jwt')).resolves.toBeUndefined();
          expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
        }
      });

      it('the service, with no token to show, says it is the service', async () => {
        const { asked, fetchImpl } = api([ok(SCOPED)]);

        expect(await flowOn(await holding(undefined), fetchImpl).loadToken('d1', { asService: true })).toEqual(SCOPED);
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: undefined, body: { deviceId: 'd1', forService: true } }]);
      });

      it('says so again each time it waits out a "too soon"', async () => {
        const { asked, fetchImpl } = api([new Response('refresh_rate_limited', { status: 429 }), ok(SCOPED)]);
        const flow = flowOn(await holding(undefined), fetchImpl, async () => undefined);

        expect(await flow.loadToken('d1', { asService: true, waitIfRefreshedJustNow: true })).toEqual(SCOPED);
        expect(asked.map((a) => a.body)).toEqual([{ deviceId: 'd1', forService: true }, { deviceId: 'd1', forService: true }]);
      });

      it('never writes the narrow token down: it must not be found where the app keeps its own', async () => {
        const fs = await holding(undefined);
        const { fetchImpl } = api([ok(SCOPED)]);

        await flowOn(fs, fetchImpl).loadToken('d1', { asService: true });

        expect(await fs.exists(TOKEN_FILE)).toBe(false);
      });

      it('where the disk holds a token, the service shows it like anyone — and opens no way of its own', async () => {
        const { asked, fetchImpl } = api([ok(FRESH)]);

        await flowOn(await holding(EXPIRED), fetchImpl).loadToken('d1', { asService: true });

        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer held-jwt', body: { deviceId: 'd1' } }]);
      });

      it('tells the service why it was given nothing, so "not now" is not taken for "never"', async () => {
        const refusals: number[] = [];
        const { fetchImpl } = api([new Response('token_required', { status: 401 })]);

        expect(await flowOn(await holding(undefined), fetchImpl).loadToken('d1', { asService: true, onRefusal: (status) => void refusals.push(status) })).toBeNull();
        expect(refusals).toEqual([401]);

        const fine = api([ok(SCOPED)]);
        await flowOn(await holding(undefined), fine.fetchImpl).loadToken('d1', { asService: true, onRefusal: (status) => void refusals.push(status) });
        expect(refusals).toEqual([401]);
      });

      it('knocks: one ask without a token, as the service, with the disk left alone', async () => {
        const fs = await holding(EXPIRED);
        const { asked, fetchImpl } = api([ok(SCOPED)]);

        expect(await flowOn(fs, fetchImpl).claimForService('d1')).toEqual({ token: SCOPED });
        expect(asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: undefined, body: { deviceId: 'd1', forService: true } }]);
        expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
      });

      it('tells a way not open from a television no longer connected, and both from "not now"', async () => {
        const knock = async (answer: Response | Error) => flowOn(await holding(undefined), api([answer]).fetchImpl).claimForService('d1');

        expect(await knock(new Response('token_required', { status: 401 }))).toBe('no_way');
        expect(await knock(new Response('device_not_paired', { status: 404 }))).toBe('not_paired');
        expect(await knock(new Response('device_denylisted', { status: 403 }))).toBe('not_paired');
        expect(await knock(new Response('refresh_rate_limited', { status: 429 }))).toBe('try_later');
        expect(await knock(new Response('oops', { status: 500 }))).toBe('try_later');
        expect(await knock(new TypeError('Network request failed'))).toBe('try_later');
        expect(await knock(new Response('not json', { status: 200 }))).toBe('try_later');
      });

      it('renews without touching the disk when told to remember nothing: neither the fresh token nor a refusal', async () => {
        const kept = await holding(EXPIRED);
        const renewed = api([ok(SCOPED)]);
        expect(await flowOn(kept, renewed.fetchImpl).renew('d1', 'scoped-jwt', { remember: false })).toEqual({ token: SCOPED });
        expect(renewed.asked).toEqual([{ url: 'https://pair.example/pair/refresh', authorization: 'Bearer scoped-jwt', body: { deviceId: 'd1' } }]);
        expect(JSON.parse(await kept.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);

        const refused = api([new Response('invalid_token', { status: 401 })]);
        expect(await flowOn(kept, refused.fetchImpl).renew('d1', 'scoped-jwt', { remember: false })).toBe('not_connected');
        expect(JSON.parse(await kept.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
      });

      // The pairing service ends a service's session in three ways of its own —
      // the token ran out, the session is seven days old, or the service was
      // let in again and this token belongs to the session before
      // (edge-device pair-refresh.mjs). Each is a 401, and each is the same
      // to the television: this token is finished, and the disk is left alone.
      it('takes every way a service’s session can end as "this token is finished", whatever the reason given', async () => {
        for (const reason of ['token_expired', 'session_over', 'session_replaced', 'invalid_token']) {
          const fs = await holding(EXPIRED);
          const { asked, fetchImpl } = api([new Response(reason, { status: 401 })]);

          expect(await flowOn(fs, fetchImpl).renew('d1', 'scoped-jwt', { remember: false })).toBe('not_connected');
          expect(asked).toHaveLength(1);
          expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
        }
      });

      it('does not write a narrow token down even when asked to remember', async () => {
        const fs = await holding(EXPIRED);
        const { fetchImpl } = api([ok(SCOPED)]);

        await flowOn(fs, fetchImpl).renew('d1', 'scoped-jwt');

        expect(JSON.parse(await fs.readFileAsString(TOKEN_FILE, 'utf8'))).toEqual(EXPIRED);
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

  // While its first request has not answered, a television that was
  // connected before shows its own screen (connect.ts) — and which screen
  // that is, is in the token it remembers, run out or not.
  describe('rememberedToken — what this television last held, whether or not it has run out', () => {
    it('is the token on disk, good or run out, with its kind', async () => {
      const fs = fakeFs();
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs, vi.fn() as unknown as typeof fetch);
      const expired: DeviceToken = { ...TOKEN, expiresAt: Date.now() - 1000, kind: 'family' };
      await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(expired), 'utf8');

      expect(await flow.rememberedToken()).toEqual(expired);

      await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(TOKEN), 'utf8');
      expect(await flow.rememberedToken()).toEqual(TOKEN);
    });

    it('is nothing where nothing is kept, or was forgotten — and asks nobody', async () => {
      const fetchMock = vi.fn();
      const fs = fakeFs();
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs, fetchMock as unknown as typeof fetch);

      expect(await flow.rememberedToken()).toBeNull();
      await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(TOKEN), 'utf8');
      await flow.clearToken();
      expect(await flow.rememberedToken()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is nothing on a disk that cannot be read', async () => {
      const fs = fakeFs();
      fs.exists = async () => {
        throw new Error('[com.amazon.kepler.io.IoError]: ');
      };

      expect(await new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs).rememberedToken()).toBeNull();
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

  // Seen on the Vega simulator, 2026-10-13: the first launch after a cold
  // boot sat on "Getting a code…" for over a minute behind a request that
  // never answered. No request to the pairing service is waited for longer
  // than this.
  describe('a request that never answers', () => {
    const never = (): typeof fetch => {
      const hung = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => {}));
      return hung as unknown as typeof fetch;
    };
    const signalOf = (fetchImpl: typeof fetch, call = 0): AbortSignal => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[call]![1].signal as AbortSignal;
    const expired: DeviceToken = { ...TOKEN, jwt: 'held-jwt', expiresAt: Date.now() - 1000 };

    it('is given ten seconds', () => {
      expect(PAIRING_REQUEST_TIMEOUT_MS).toBe(10_000);
    });

    it('fails the asking for a code once its time is up, and is told to stop', async () => {
      vi.useFakeTimers();
      try {
        const fetchImpl = never();
        const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), fetchImpl);

        const starting = flow.start('d1');
        const failed = expect(starting).rejects.toThrow('pairing_request_timed_out');
        await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS - 1);
        expect(signalOf(fetchImpl).aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        await failed;
        expect(signalOf(fetchImpl).aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('fails the launch-time refresh the same way, and keeps the token it was showing', async () => {
      vi.useFakeTimers();
      try {
        const fs = fakeFs();
        await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(expired), 'utf8');
        const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', requestTimeoutMs: 4_000 }, fs, never());

        const loading = flow.loadToken('d1');
        const failed = expect(loading).rejects.toThrow('pairing_request_timed_out');
        await vi.advanceTimersByTimeAsync(4_000);

        await failed;
        expect(JSON.parse(await fs.readFileAsString('/data/wick-token.json', 'utf8'))).toEqual(expired);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is only "not now" for a renewal, a knock, and the opening of the way', async () => {
      vi.useFakeTimers();
      try {
        const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), never());

        const renewed = flow.renew('d1', 'held-jwt');
        const claimed = flow.claimForService('d1');
        const opened = flow.openServiceWindow('d1', 'held-jwt');
        await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS);

        expect(await renewed).toBe('try_later');
        expect(await claimed).toBe('try_later');
        await expect(opened).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not end the wait for the code to be entered: the question is asked again', async () => {
      vi.useFakeTimers();
      try {
        const answers: Array<Promise<Response>> = [
          new Promise<Response>(() => {}),
          Promise.resolve(new Response(JSON.stringify({ status: 'bound', token: TOKEN }), { status: 200 })),
        ];
        const fetchImpl = vi.fn(() => answers.shift()!);
        const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', pollIntervalMs: 3_000 }, fakeFs(), fetchImpl as unknown as typeof fetch);

        const polling = flow.pollUntilBound('123456');
        await vi.advanceTimersByTimeAsync(PAIRING_REQUEST_TIMEOUT_MS + 3_000);

        expect(await polling).toEqual(TOKEN);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('nor does one that fails, or a pairing service in trouble: only the code having gone ends it', async () => {
      const answers: Array<Response | Error> = [
        new TypeError('Network request failed'),
        new Response('oops', { status: 503 }),
        new Response(JSON.stringify({ status: 'pending' }), { status: 200 }),
        new Response('gone', { status: 404 }),
      ];
      const fetchImpl = vi.fn(async () => {
        const next = answers.shift()!;
        if (next instanceof Error) throw next;
        return next;
      });
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', pollIntervalMs: 1 }, fakeFs(), fetchImpl as unknown as typeof fetch);

      await expect(flow.pollUntilBound('123456')).rejects.toThrow('pairing_code_expired');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('still gives up on a code nobody enters, when its quarter of an hour is over', async () => {
      const fetchImpl = vi.fn(async () => new Response('oops', { status: 503 }));
      const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example', pollIntervalMs: 1, pollTimeoutMs: 20 }, fakeFs(), fetchImpl as unknown as typeof fetch);

      await expect(flow.pollUntilBound('123456')).rejects.toThrow('pairing_timed_out');
    });
  });
});
