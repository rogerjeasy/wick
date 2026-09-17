/**
 * Container-scoped device-list cache, same shape as secrets.ts's token cache.
 *
 * The door orchestrator needs one field — capabilities.chime — to decide
 * whether "Just a moment" is drawn (index.ts). Fetching the whole device
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

export function cachedDeviceLookup(options: CachedDeviceLookupOptions): DeviceLookup {
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

  return async (deviceId: string) => {
    const fresh = cached && now() - cached.fetchedAt < cacheMs;
    const devices = fresh ? cached!.devices : await fetch();
    return devices.find((d) => d.id === deviceId);
  };
}
