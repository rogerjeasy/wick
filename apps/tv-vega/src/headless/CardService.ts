/**
 * com.wick.tv.card.service — holds the device channel while the app package is
 * alive, so a card can arrive without the UI being mounted.
 *
 * Isolated in its own process group (manifest.toml) so a UI crash cannot drop
 * the channel.
 *
 * FL-014: on the VVD the platform never launches this process, so it is no
 * longer the only holder of the channel — App.tsx runs the same
 * startCardChannel() in the main process while Wick is on screen. This stays
 * for the background case wherever the platform does start the service.
 *
 * NOTE: this does NOT make Wick able to draw over another app's playback. That
 * is SP-1, the project's pivot question. See docs/WICK-TECHNICAL.md §14.
 */
import type { DeviceChannel } from '@wick/contracts';
import { createDeviceChannel, type DeviceChannelConfig } from '../transport/createDeviceChannel.js';
import { startCardChannel, type RunningCardChannel } from '../transport/startCardChannel.js';
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

  const channelConfig: DeviceChannelConfig = {
    websocket: { url: config.websocketUrl, getLastSeenCardId: () => store.lastSeenCardId() },
    ...(config.mqttWssUrl ? { mqtt: { wssUrl: config.mqttWssUrl } } : {}),
  };

  running = startCardChannel(store, await createChannel(channelConfig, token));
}

export async function onStopCardService(): Promise<void> {
  running?.stop();
  running = undefined;
}
