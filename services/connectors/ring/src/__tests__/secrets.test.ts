import { describe, it, expect } from 'vitest';
import {
  RING_TOKEN_SECRET_ID,
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

  it('reads the token out of the default secret', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok', expiresAt: NOW + HOUR }]);
    const provider = secretsManagerTokenProvider({ client, now: () => NOW });

    await expect(provider()).resolves.toBe('tok');
    expect(calls[0]).toBe(RING_TOKEN_SECRET_ID);
  });

  it('caches, so a fan-out of Ring calls does not pay a lookup each', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok', expiresAt: NOW + HOUR }]);
    const provider = secretsManagerTokenProvider({ client, now: () => NOW });

    await Promise.all([provider(), provider(), provider()]);
    expect(calls).toHaveLength(1);
  });

  it('re-reads once the cache window passes', async () => {
    const { client, calls } = stubClient([
      { access_token: 'first', expiresAt: NOW + HOUR },
      { access_token: 'second', expiresAt: NOW + HOUR },
    ]);
    let t = NOW;
    const provider = secretsManagerTokenProvider({ client, cacheMs: 1000, now: () => t });

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
    const provider = secretsManagerTokenProvider({ client, cacheMs: 60_000, now: () => t });

    await expect(provider()).resolves.toBe('stale');
    t += 1000; // token dead, cache window still open
    await expect(provider()).resolves.toBe('fresh');
  });

  it('says "not linked" for a secret with no version yet', async () => {
    const { client } = stubClient([undefined]);
    const provider = secretsManagerTokenProvider({ client, now: () => NOW });
    await expect(provider()).rejects.toThrow(/not_linked/);
  });

  it('honours an explicit secret id', async () => {
    const { client, calls } = stubClient([{ access_token: 'tok' }]);
    await secretsManagerTokenProvider({ client, secretId: 'other/secret', now: () => NOW })();
    expect(calls[0]).toBe('other/secret');
  });
});
