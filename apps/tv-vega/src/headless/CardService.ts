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
 *
 * On a family member's own television it holds no connection at all:
 * nothing of the resident's is sent to one. It asks the Wick server what
 * waits for that member and says so in a toast (headless/waitingService.ts).
 */
import type { DeviceChannel, DeviceToken } from '@wick/contracts';
import { createDeviceChannel, type DeviceChannelConfig } from '../transport/createDeviceChannel.js';
import { holdCardChannel, type RunningCardChannel } from '../transport/startCardChannel.js';
import { doorToast, postToast, type ToastContent } from '../notify/doorToast.js';
import { QueueStore, type FileSystemLike } from './QueueStore.js';
import { PairingFlow } from '../pairing/PairingFlow.js';
import { standingWatch } from '../pairing/standing.js';
import { loadDeviceConfig, type DeviceConfig } from '../config.js';
import { resolveDeviceId } from '../deviceId.js';
import { createFamilyClient, type Renewed } from '../family/familyClient.js';
import { televisionMode } from '../family/mode.js';
import { runWaitingService, type Claimed } from './waitingService.js';

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

const START_BUDGET_MS = 3000;

/** What this process holds: the resident's background connection, or a family television's asking. */
let running: Pick<RunningCardChannel, 'stop'> | undefined;
/** What a family television has already been told is waiting, for the life of this process — a stop and a start do not make it news again. */
const saidWaiting = new Set<string>();
/** The pairing service's "a token is required": this is a family member's television, and the way for its service is not open. */
const TOKEN_REQUIRED = 401;
/** Counts starts and stops, so a start that was still waiting for its token knows it was overtaken. */
let starts = 0;

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
  //
  // The app asks for the same refresh a second before it starts this
  // process, and the server allows one in 30 seconds — so this one may wait
  // and ask again. There is no screen here to fall back to.
  const starting = ++starts;
  const announce = testDeps?.postToast ?? postToast;
  let late = false;
  const holding = (async () => {
    const deviceId = await resolveDeviceId(fs);
    let refusal: number | undefined;
    // With no token to show, the request says it is the service: a family
    // television's is then handed the one narrow token its app opened the
    // way for (PairingFlow.openServiceWindow). The resident's is answered
    // as it always was.
    //
    // What the disk held before anything was asked: a token that comes back
    // different was handed over by the pairing service just now, and its
    // hour is counted from here (pairing/held.ts).
    const before = await pairing.rememberedToken();
    const token = await pairing.loadToken(deviceId, {
      waitIfRefreshedJustNow: true,
      asService: true,
      onRefusal: (status) => {
        refusal = status;
      },
    });
    if (starting !== starts) return; // stopped, or started again, while waiting
    if (token && televisionMode(token) === 'resident') {
      // A television the family has disconnected is refused this connection
      // for good, and from here that looks like a network that has gone:
      // the channel would try again for ever. So its trouble is asked about
      // (pairing/standing.ts), and "not connected" ends it. The token file
      // is left alone — it is the app's, which asks the same question when
      // it is next on screen, and forgets.
      //
      // So is a television whose token has run out — an hour after this
      // service started, where the disk keeps none. This connection is
      // checked only as it opens, so the hour passes unnoticed until it
      // next drops; the reconnection is then refused for good, with the
      // token it was given. The answer to the same question is "connected",
      // and comes with a fresh token: the connection is let go and held
      // again with that one. Nothing is written down here either.
      const hold = (inUse: DeviceToken): RunningCardChannel =>
        holdCardChannel(
          store,
          inUse,
          createChannel,
          config,
          (card) => {
            const toast = doorToast(card);
            if (toast) void announce(toast);
          },
          undefined,
          () => standing.trouble(),
        );
      let channel: RunningCardChannel | undefined;
      const held = {
        stop(): void {
          standing.stop();
          channel?.stop();
        },
      };
      const standing = standingWatch({
        held: { token, ...(token.jwt !== before?.jwt ? { since: Date.now() } : {}) },
        ask: (inUse) => pairing.renew(deviceId, inUse.jwt, { remember: false }),
        onGone: () => {
          held.stop();
          if (running === held) running = undefined;
        },
        onFresh: (fresh) => {
          channel?.stop();
          channel = hold(fresh);
        },
      });
      channel = hold(token);
      running = held;
      return;
    }
    // Genuinely unpaired — App.tsx shows the pairing screen; nothing to hold
    // open, and nothing to wait for. Only "a token is required" says this
    // is a family television whose way is not open yet: that is waited for.
    if (!token && refusal !== TOKEN_REQUIRED) return;

    // A family member's own television has no card channel: nothing of the
    // resident's is sent to it. It asks what waits, and says so.
    running = runWaitingService(token ?? undefined, {
      said: saidWaiting,
      announce: (toast) => void announce(toast),
      claim: async (): Promise<Claimed> => {
        const claimed = await pairing.claimForService(deviceId);
        // Only ever a family television's token is taken here; anything else is not this service's to use.
        return typeof claimed === 'object' && televisionMode(claimed.token) !== 'family' ? 'not_paired' : claimed;
      },
      clientFor: (held) =>
        createFamilyClient({
          serverUrl: config.wickServerUrl,
          jwt: held.jwt,
          ...(testDeps?.fetchImpl ? { fetchImpl: testDeps.fetchImpl } : {}),
          // The token in hand is the proof. Nothing is written down and nothing forgotten: the file on disk is the app's.
          renew: async (heldJwt): Promise<Renewed> => {
            const renewed = await pairing.renew(deviceId, heldJwt, { remember: false });
            if (renewed === 'not_connected' || renewed === 'try_later') return renewed;
            return televisionMode(renewed.token) === 'family' ? { jwt: renewed.token.jwt } : 'not_connected';
          },
        }),
    });
  })().catch((err: unknown) => {
    if (!late) throw err;
    console.error('card_service_token_failed', err);
  });

  // The system ends a service whose start has not returned in about eight
  // seconds (Vega simulator, 2026-10-11: "START transition timed out",
  // AppNotResponding). The wait for a token is far longer, so the start
  // returns without it and the connection is taken up when it comes.
  let budget: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    holding,
    new Promise<void>((resolve) => {
      budget = setTimeout(() => {
        late = true;
        resolve();
      }, START_BUDGET_MS);
    }),
  ]);
  clearTimeout(budget);
}

export async function onStopCardService(): Promise<void> {
  starts += 1;
  running?.stop();
  running = undefined;
}
