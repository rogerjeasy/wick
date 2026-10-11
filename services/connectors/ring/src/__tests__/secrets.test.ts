import { describe, it, expect } from 'vitest';
import {
  RING_TOKEN_SECRET_PREFIX,
  ringClientsByHousehold,
  ringTokenSecretId,
  RingTokenUnavailable,
  accessTokenFrom,
  secretsManagerTokenProvider,
} from '../secrets.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe('accessTokenFrom', () => {
  it('returns a token that is still good', () => {
    expect(accessTokenFrom({ access_token: 'tok', expiresAt: NOW + HOUR }, NOW)).toBe('tok');
  });

  it('computes expiry from obtainedAt + expires_in for older records', () => {
    expect(accessTokenFrom({ access_token: 'tok', obtainedAt: NOW, expires_in: 3600 }, NOW))
      .toBe('tok');
    expect(() =>
      accessTokenFrom({ access_token: 'tok', obtainedAt: NOW - 2 * HOUR, expires_in: 3600 }, NOW),
    ).toThrow(RingTokenUnavailable);
  });

  it('distinguishes "nobody has linked" from "the refresh schedule stopped"', () => {
    // Different problems, different fixes: one needs a human to authorise, the
    // other means wick-ring-refresh is broken. Never collapse them.
    expect(() => accessTokenFrom(null, NOW)).toThrow(/not_linked/);
    expect(() => accessTokenFrom({}, NOW)).toThrow(/not_linked/);
    expect(() => accessTokenFrom({ access_token: 't', expiresAt: NOW - 1 }, NOW))
      .toThrow(/expired/);
  });

  it('names the refresh schedule in the expiry message, so the fix is obvious', () => {
    try {
      accessTokenFrom({ access_token: 't', expiresAt: NOW - 5000 }, NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('wick-ring-refresh');
    }
  });

  it('allows a record with no expiry information rather than guessing it is dead', () => {
    expect(accessTokenFrom({ access_token: 'tok' }, NOW)).toBe('tok');
  });
});

describe('secretsManagerTokenProvider', () => {
  function stubClient(records: unknown[]) {
    let i = 0;
    const calls: string[] = [];
    return {
      calls,
      client: {
        send: async (cmd: { input: { SecretId?: string } }) => {
          calls.push(cmd.input.SecretId ?? '');
          const r = records[Math.min(i++, records.length - 1)];
          return { SecretString: r === undefined ? undefined : JSON.stringify(r) };
        },
      } as never,
    };
  }

  it('reads the token out of that household\'s own secret', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok', expiresAt: NOW + HOUR }]);
    const provider = secretsManagerTokenProvider('hh_a', { client, now: () => NOW });

    await expect(provider()).resolves.toBe('tok');
    expect(calls[0]).toBe(`${RING_TOKEN_SECRET_PREFIX}/hh_a`);
  });

  it('says "not linked" for a household that has never connected Ring — no secret exists', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('Secrets Manager can\'t find the specified secret.'), { name: 'ResourceNotFoundException' });
      },
    } as never;

    await expect(secretsManagerTokenProvider('hh_new', { client, now: () => NOW })()).rejects.toThrow(/not_linked/);
  });

  it('does not hide any other failure as "not linked"', async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error('User is not authorized'), { name: 'AccessDeniedException' });
      },
    } as never;

    await expect(secretsManagerTokenProvider('hh_a', { client, now: () => NOW })()).rejects.toThrow('not authorized');
  });

  it('caches, so a fan-out of Ring calls does not pay a lookup each', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok', expiresAt: NOW + HOUR }]);
    const provider = secretsManagerTokenProvider('hh_a', { client, now: () => NOW });

    await Promise.all([provider(), provider(), provider()]);
    expect(calls).toHaveLength(1);
  });

  it('re-reads once the cache window passes', async () => {
    const { client, calls } = stubClient([
      { access_token: 'first', expiresAt: NOW + HOUR },
      { access_token: 'second', expiresAt: NOW + HOUR },
    ]);
    let t = NOW;
    const provider = secretsManagerTokenProvider('hh_a', { client, cacheMs: 1000, now: () => t });

    await expect(provider()).resolves.toBe('first');
    t += 2000;
    await expect(provider()).resolves.toBe('second');
    expect(calls).toHaveLength(2);
  });

  it('drops a cached token that expires inside its own cache window', async () => {
    const { client } = stubClient([
      { access_token: 'stale', expiresAt: NOW + 500 },
      { access_token: 'fresh', expiresAt: NOW + HOUR },
    ]);
    let t = NOW;
    const provider = secretsManagerTokenProvider('hh_a', { client, cacheMs: 60_000, now: () => t });

    await expect(provider()).resolves.toBe('stale');
    t += 1000; // token dead, cache window still open
    await expect(provider()).resolves.toBe('fresh');
  });

  it('says "not linked" for a secret with no version yet', async () => {
    const { client } = stubClient([undefined]);
    const provider = secretsManagerTokenProvider('hh_a', { client, now: () => NOW });
    await expect(provider()).rejects.toThrow(/not_linked/);
  });

  it('honours an explicit secret id', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok' }]);
    await secretsManagerTokenProvider('hh_a', { client, secretId: 'other/secret', now: () => NOW })();
    expect(calls[0]).toBe('other/secret');
  });
});

describe('ringTokenSecretId', () => {
  it('names one secret per household', () => {
    expect(ringTokenSecretId('hh_a')).toBe('wick/ring/tokens/hh_a');
    expect(ringTokenSecretId('margaret')).toBe('wick/ring/tokens/margaret');
    expect(ringTokenSecretId('hh_a')).not.toBe(ringTokenSecretId('hh_b'));
  });

  it('refuses an id that could name a secret outside the household\'s own', () => {
    for (const id of ['', '../credentials', 'hh_a/../hh_b', 'hh a', '*', 'a'.repeat(65)]) {
      expect(() => ringTokenSecretId(id), id).toThrow('unsafe_household_id');
    }
  });
});

describe('ringClientsByHousehold', () => {
  /** Secrets Manager holding a different token for each household. */
  function vault(tokens: Record<string, string>) {
    const asked: string[] = [];
    const client = {
      send: async (cmd: { input: { SecretId?: string } }) => {
        const id = cmd.input.SecretId ?? '';
        asked.push(id);
        const household = id.slice(`${RING_TOKEN_SECRET_PREFIX}/`.length);
        if (!(household in tokens)) throw Object.assign(new Error('no such secret'), { name: 'ResourceNotFoundException' });
        return { SecretString: JSON.stringify({ access_token: tokens[household], expiresAt: NOW + HOUR }) };
      },
    } as never;
    return { client, asked };
  }

  /** A stand-in for Ring that records the bearer token of each request. Nothing here reaches the network. */
  function fakeRing() {
    const bearers: (string | null)[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { bearers, fetch: fetchImpl };
  }

  it('gives each household a client that carries that household\'s token and no other', async () => {
    const { client } = vault({ hh_a: 'token-a', hh_b: 'token-b' });
    const ring = fakeRing();
    const clientFor = ringClientsByHousehold({ client, now: () => NOW, fetchImpl: ring.fetch });

    await clientFor('hh_a').get('/v1/devices');
    await clientFor('hh_b').get('/v1/devices');
    await clientFor('hh_a').get('/v1/devices');

    expect(ring.bearers).toEqual(['Bearer token-a', 'Bearer token-b', 'Bearer token-a']);
  });

  it('keeps one client per household, so its token cache is reused', async () => {
    const { client, asked } = vault({ hh_a: 'token-a' });
    const clientFor = ringClientsByHousehold({ client, now: () => NOW, fetchImpl: fakeRing().fetch });

    expect(clientFor('hh_a')).toBe(clientFor('hh_a'));
    await clientFor('hh_a').get('/v1/devices');
    await clientFor('hh_a').get('/v1/devices');

    expect(asked).toEqual(['wick/ring/tokens/hh_a']);
  });

  it('has nothing for a household that has not connected Ring — never another home\'s token', async () => {
    const { client } = vault({ hh_a: 'token-a' });
    const ring = fakeRing();
    const clientFor = ringClientsByHousehold({ client, now: () => NOW, fetchImpl: ring.fetch });

    await expect(clientFor('hh_b').get('/v1/devices')).rejects.toThrow(/not_linked/);
    expect(ring.bearers).toEqual([]);
  });
});

describe('ringClientsByHousehold and a secret named once', () => {
  it('takes no secret name — and ignores one given anyway: one name would be every household\'s secret', async () => {
    const asked: string[] = [];
    const client = {
      send: async (cmd: { input: { SecretId?: string } }) => {
        asked.push(cmd.input.SecretId ?? '');
        return { SecretString: JSON.stringify({ access_token: 'tok', expiresAt: NOW + HOUR }) };
      },
    } as never;
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    // @ts-expect-error — `secretId` is deliberately not an option here.
    const clientFor = ringClientsByHousehold({ client, now: () => NOW, fetchImpl, secretId: 'wick/ring/tokens/hh_a' });

    await clientFor('hh_b').get('/v1/devices');

    expect(asked).toEqual(['wick/ring/tokens/hh_b']);
  });
});
