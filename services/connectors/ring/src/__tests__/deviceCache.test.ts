import { describe, it, expect, vi } from 'vitest';
import { cachedDeviceLookup, cachedDevices } from '../deviceCache.js';
import type { RingDevice } from '../types.js';

const device = (id: string): RingDevice => ({
  id,
  name: `Device ${id}`,
  online: true,
  capabilities: { motion: true, image: true, chime: true },
});

describe('cachedDeviceLookup', () => {
  it('fetches the list on first use and finds the requested device', async () => {
    const list = vi.fn(async () => [device('a'), device('b')]);
    const lookup = cachedDeviceLookup({ list });

    const found = await lookup('b');

    expect(found?.id).toBe('b');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for a device the account does not have', async () => {
    const list = vi.fn(async () => [device('a')]);
    const lookup = cachedDeviceLookup({ list });

    expect(await lookup('missing')).toBeUndefined();
  });

  it('reuses the cached list within cacheMs — no repeat network call', async () => {
    const list = vi.fn(async () => [device('a')]);
    let now = 0;
    const lookup = cachedDeviceLookup({ list, cacheMs: 60_000, now: () => now });

    await lookup('a');
    now += 30_000;
    await lookup('a');

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cache has aged past cacheMs — a chime added mid-demo should show up', async () => {
    const list = vi.fn(async () => [device('a')]);
    let now = 0;
    const lookup = cachedDeviceLookup({ list, cacheMs: 60_000, now: () => now });

    await lookup('a');
    now += 60_001;
    await lookup('a');

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('single-flights concurrent lookups instead of issuing one fetch per caller', async () => {
    let resolveList: (devices: RingDevice[]) => void;
    const list = vi.fn(
      () =>
        new Promise<RingDevice[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const lookup = cachedDeviceLookup({ list });

    const first = lookup('a');
    const second = lookup('a');
    resolveList!([device('a')]);
    await Promise.all([first, second]);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch — a transient outage should not blank the device list for cacheMs', async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ring_api_500');
      return [device('a')];
    });
    const lookup = cachedDeviceLookup({ list });

    await expect(lookup('a')).rejects.toThrow('ring_api_500');
    expect((await lookup('a'))?.id).toBe('a');
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('cachedDevices', () => {
  it('serves find() and all() from one fetch — Phase 1 needs both the camera and the chime', async () => {
    const list = vi.fn(async () => [device('cam'), device('chime')]);
    const devices = cachedDevices({ list, now: () => 0 });

    expect((await devices.find('cam'))?.id).toBe('cam');
    expect((await devices.all()).map((d) => d.id)).toEqual(['cam', 'chime']);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
