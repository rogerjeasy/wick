/**
 * Container-scoped device-list cache, same shape as secrets.ts's token cache.
 *
 * The door orchestrator needs the doorbell the event came from, and whether
 * the household has a playable Ring Chime — which decides whether "Ring the
 * hallway chime" is drawn (index.ts). Fetching the whole device
 * list from Ring on every warm invocation would spend Phase 1's local, no
 * network budget on a lookup that rarely changes. This reuses the list
 * across invocations of the same Lambda container and re-fetches only once
 * it goes stale.
 */
import type { RingDevice } from './types.js';

export interface DeviceLookup {
  (deviceId: string): Promise<RingDevice | undefined>;
}

export interface CachedDeviceLookupOptions {
  readonly list: () => Promise<readonly RingDevice[]>;
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export interface CachedDevices {
  find(deviceId: string): Promise<RingDevice | undefined>;
  all(): Promise<readonly RingDevice[]>;
}

export function cachedDevices(options: CachedDeviceLookupOptions): CachedDevices {
  const { list } = options;
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;

  let cached: { devices: readonly RingDevice[]; fetchedAt: number } | null = null;
  let inFlight: Promise<readonly RingDevice[]> | null = null;

  async function fetch(): Promise<readonly RingDevice[]> {
    // Single-flight: a burst of near-simultaneous door events on a cold cache
    // should issue one Ring call, not one per event.
    inFlight ??= (async () => {
      try {
        const devices = await list();
        cached = { devices, fetchedAt: now() };
        return devices;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const all = async (): Promise<readonly RingDevice[]> =>
    cached && now() - cached.fetchedAt < cacheMs ? cached.devices : fetch();

  return { all, find: async (deviceId) => (await all()).find((d) => d.id === deviceId) };
}

export function cachedDeviceLookup(options: CachedDeviceLookupOptions): DeviceLookup {
  return cachedDevices(options).find;
}
