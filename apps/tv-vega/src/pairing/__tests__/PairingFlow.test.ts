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
    await fs.writeStringToFile('/wick/token.json', JSON.stringify(TOKEN), 'utf8');

    await flow.clearToken();

    expect(await flow.loadToken()).toBeNull();
  });
});
