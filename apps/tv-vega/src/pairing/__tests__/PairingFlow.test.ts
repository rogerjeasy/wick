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
        expect(JSON.parse(String(init?.body))).toEqual({ deviceId: 'd1', householdId: 'h1' });
        return new Response(JSON.stringify({ token: TOKEN }), { status: 200 });
      });
      const fs = fakeFs();
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example', householdId: 'h1' },
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
        { pairingApiUrl: 'https://pair.example', householdId: 'h1' },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken('d1')).toBeNull();
    });

    it('returns null without calling /pair/refresh when no householdId is configured', async () => {
      const fetchMock = vi.fn();
      const flow = new PairingFlow(
        { pairingApiUrl: 'https://pair.example' },
        fakeFs(),
        fetchMock as unknown as typeof fetch,
      );

      expect(await flow.loadToken('d1')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
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
        { pairingApiUrl: 'https://pair.example', householdId: 'h1' },
        fs,
        fetchMock as unknown as typeof fetch,
      );

      await expect(flow.loadToken('d1')).resolves.toEqual(TOKEN);
    });
  });
});
