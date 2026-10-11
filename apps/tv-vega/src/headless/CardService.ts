/**
 * com.wick.tv.card.service — the part of Wick that keeps running while
 * another app is in front.
 *
 * It holds the television's *background* connection (WebSocketChannel's
 * `role`). The server sends a card there only when the app itself is not
 * on screen (edge-device connection-slot.mjs, agent egress.ts), and all
 * this process can do with one is announce it: a system toast for a door
 * card (notify/doorToast.ts), whose button brings Wick forward, and a
 * second toast with the picture and what was seen at the door once the
 * door agent has them (transport/startCardChannel.ts). The card itself is
 * rendered by the app, which gets it from the server when it connects.
 *
 * Isolated in its own process group (manifest.toml) so a UI crash cannot drop
 * the channel.
 *
 * FL-014, resolved: nothing starts this process by itself. App.tsx starts
 * it, by its `pkg://` URI, once the television is paired (FL-022).
 */
import type { DeviceChannel } from '@wick/contracts';
import { createDeviceChannel, type DeviceChannelConfig } from '../transport/createDeviceChannel.js';
import { holdCardChannel, type RunningCardChannel } from '../transport/startCardChannel.js';
import { doorToast, postToast, type ToastContent } from '../notify/doorToast.js';
import { QueueStore, type FileSystemLike } from './QueueStore.js';
import { PairingFlow } from '../pairing/PairingFlow.js';
import { loadDeviceConfig, type DeviceConfig } from '../config.js';
import { resolveDeviceId } from '../deviceId.js';

interface TestDeps {
  readonly fs: FileSystemLike;
  readonly config: DeviceConfig;
  readonly createChannel: (config: DeviceChannelConfig, token: Parameters<typeof createDeviceChannel>[1]) => Promise<DeviceChannel>;
  /** Injectable so tests can stub PairingFlow's server-side refresh fallback without a real network call. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests see the toast instead of looking a TurboModule up. */
  readonly postToast?: (toast: ToastContent) => Promise<void>;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — the registered headless hooks below stay parameterless. */
export function __setCardServiceTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

let running: RunningCardChannel | undefined;

export async function onStartCardService(): Promise<void> {
  // Imported lazily, and only on the real (non-test) path: the module's
  // named `KeplerFileSystem` export (there is no default export — see
  // dist/index.d.ts) is a native TurboModule looked up via
  // TurboModuleRegistry.getEnforcing() as an import-time side effect, which
  // throws outside an actual Vega runtime — a static top-level import would
  // crash CardService.test.ts (and anything else importing this module)
  // before __setCardServiceTestDeps ever gets a chance to substitute a fake.
  const fs = testDeps?.fs ?? (await import('@amazon-devices/kepler-file-system')).KeplerFileSystem;
  const config = testDeps?.config ?? loadDeviceConfig();
  const createChannel = testDeps?.createChannel ?? createDeviceChannel;

  const store = new QueueStore(fs);
  const pairing = new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, fs, testDeps?.fetchImpl);

  // Passing the device id lets loadToken() fall back to a server-side refresh
  // when disk has nothing — this process's only other option, since it
  // never calls start()/pollUntilBound() itself and has no in-memory token
  // from App.tsx's own pairing (separate process, no shared JS memory). See
  // PairingFlow.loadToken's header comment and FRICTION.md.
  const token = await pairing.loadToken(await resolveDeviceId(fs));
  if (!token) return; // genuinely unpaired — App.tsx shows the pairing screen; nothing to hold open yet

  const announce = testDeps?.postToast ?? postToast;
  running = holdCardChannel(store, token, createChannel, config, (card) => {
    const toast = doorToast(card);
    if (toast) void announce(toast);
  });
}

export async function onStopCardService(): Promise<void> {
  running?.stop();
  running = undefined;
}
