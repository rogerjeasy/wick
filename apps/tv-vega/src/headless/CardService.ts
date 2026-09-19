/**
 * com.wick.tv.card.service — holds the device channel while the app package is
 * alive, so a card can arrive without the UI being mounted.
 *
 * Isolated in its own process group (manifest.toml) so a UI crash cannot drop
 * the channel.
 *
 * NOTE: this does NOT make Wick able to draw over another app's playback. That
 * is SP-1, the project's pivot question. See docs/WICK-TECHNICAL.md §14.
 */
import type { ControlMessage, DeviceChannel, QueuedCard } from '@wick/contracts';
import { createDeviceChannel, type DeviceChannelConfig } from '../transport/createDeviceChannel.js';
import { QueueStore, type FileSystemLike } from './QueueStore.js';
import { PairingFlow } from '../pairing/PairingFlow.js';
import { loadDeviceConfig, type DeviceConfig } from '../config.js';
import { DEVICE_ID } from '../deviceId.js';

const OUTBOX_POLL_MS = 1000;

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

let channel: DeviceChannel | undefined;
let unsubscribeCard: (() => void) | undefined;
let unsubscribeControl: (() => void) | undefined;
let outboxTimer: ReturnType<typeof setInterval> | undefined;

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
  const pairing = new PairingFlow(
    { pairingApiUrl: config.pairingApiUrl, householdId: config.householdId },
    fs,
    testDeps?.fetchImpl,
  );

  // Passing DEVICE_ID lets loadToken() fall back to a server-side refresh
  // when disk has nothing — this process's only other option, since it
  // never calls start()/pollUntilBound() itself and has no in-memory token
  // from App.tsx's own pairing (separate process, no shared JS memory). See
  // PairingFlow.loadToken's header comment and FRICTION.md.
  const token = await pairing.loadToken(DEVICE_ID);
  if (!token) return; // genuinely unpaired — App.tsx shows the pairing screen; nothing to hold open yet

  const channelConfig: DeviceChannelConfig = {
    websocket: { url: config.websocketUrl, getLastSeenCardId: () => store.lastSeenCardId() },
    ...(config.mqttWssUrl ? { mqtt: { wssUrl: config.mqttWssUrl } } : {}),
  };

  channel = await createChannel(channelConfig, token);

  unsubscribeCard = channel.onCard((card: QueuedCard) => {
    void store.upsert(card);
    void channel?.send({ t: 'card_shown', cardId: card.id, at: Date.now() });
  });

  unsubscribeControl = channel.onControl((msg: ControlMessage) => {
    if (msg.t === 'patch') void store.applyPatch(msg.patch);
    else if (msg.t === 'revoke') void store.remove(msg.cardId);
  });

  outboxTimer = setInterval(() => void flushOutbox(store), OUTBOX_POLL_MS);
}

export async function onStopCardService(): Promise<void> {
  clearInterval(outboxTimer);
  outboxTimer = undefined;
  unsubscribeCard?.();
  unsubscribeControl?.();
  unsubscribeCard = undefined;
  unsubscribeControl = undefined;
  channel?.close();
  channel = undefined;
}

async function flushOutbox(store: QueueStore): Promise<void> {
  if (!channel || channel.state !== 'open') return;
  const events = await store.drainOutbound();
  for (const event of events) {
    try {
      await channel.send(event);
    } catch {
      await store.enqueueOutbound(event); // best-effort — retried next tick
    }
  }
}
