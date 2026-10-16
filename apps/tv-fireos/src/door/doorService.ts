/**
 * The door, outside Wick, on Fire OS — the JavaScript the Android
 * foreground service runs (android/.../door/DoorService.kt, through React
 * Native's Headless JS).
 *
 * The Fire OS counterpart of the resident's half of the Vega card service
 * (apps/tv-vega/src/headless/CardService.ts), built from the same parts: it
 * holds the television's *background* connection (the WebSocket's
 * `role=background`, transport/startCardChannel.ts), which the server sends
 * to only while the app itself has no connection — that is, while Wick is
 * not on screen (edge-device connection-slot.mjs, agent egress.ts). All it
 * does with a card is say so: a notification for a door card
 * (door/doorAlert.ts), said again once when the door agent's picture and
 * description come, and taken down when the card is taken back.
 *
 * Three things are different from Vega, because on Android the service is
 * not a process of its own: it runs in the app's process, against the
 * app's storage.
 *
 *   - Its token is the one the app keeps (pairing/PairingFlow.ts
 *     `loadToken`): the device-bound JWT and nothing else (INV-1). A token
 *     near its end is renewed with this television's secret, as the app
 *     renews its own (pairing/standing.ts), and nothing is written down
 *     for it: the token file is the app's.
 *   - Her language is the one the app keeps beside the token, read again
 *     for each notification.
 *   - The cards it is sent are held in memory only. The app keeps its own
 *     cards on the same disk, and nothing the service is sent is the app's
 *     to show: the app is sent every card it is owed when it connects.
 *
 * It holds only while the app keeps that same token: with none kept, or
 * another television's, the connection is let go and every notification it
 * put up is taken down (INV-1, INV-8) — and for another television's, taken
 * up again with the new token (`doorRunner`).
 *
 * On a family member's own television it holds nothing, and ends: nothing
 * of the resident's is ever sent to one, and what waits for that member is
 * not said outside Wick on Fire OS.
 */
import { isHouseholdLanguage, type DeviceToken, type HouseholdLanguage, type QueuedCard } from '@wick/contracts';
import { QueueStore, type FileSystemLike } from '../../../tv-vega/src/headless/QueueStore.js';
import { PairingFlow, TOKEN_PATH } from '../../../tv-vega/src/pairing/PairingFlow.js';
import { standingWatch } from '../../../tv-vega/src/pairing/standing.js';
import { resolveDeviceId, televisionIdentity } from '../../../tv-vega/src/deviceId.js';
import { televisionMode } from '../../../tv-vega/src/family/mode.js';
import { holdCardChannel, type ChannelFactory, type RunningCardChannel } from '../../../tv-vega/src/transport/startCardChannel.js';
import { createDeviceChannel } from '../../../tv-vega/src/transport/createDeviceChannel.js';
import type { DeviceConfig } from '../../../tv-vega/src/config.js';
import { doorAlert, type DoorAlert } from './doorAlert.js';

/**
 * Where the app's store keeps her language (apps/tv-vega/src/headless/
 * QueueStore.ts): read here, never written. src/__tests__/doorService.test.ts
 * holds the two to the same file.
 */
export const LANGUAGE_PATH = '/data/wick-language.json';

/** What Android is asked to do with a notification (door/native.ts). */
export interface DoorAlerts {
  show(alert: DoorAlert): Promise<void>;
  clear(cardId: string): Promise<void>;
}

export interface DoorServiceDeps {
  /** The app's storage: the token, this television's identity, her language. */
  readonly fs: FileSystemLike;
  readonly config: DeviceConfig;
  readonly alerts: DoorAlerts;
  readonly createChannel?: ChannelFactory;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** How often the token the app keeps is looked at (KEPT_TOKEN_EVERY_MS); shorter in tests. */
  readonly keptEveryMs?: number;
}

/**
 * How often the service looks at the token the app keeps. The app is the
 * one that pairs, forgets and is paired again; the service only holds. Read
 * from the app's own storage, in the same process: nothing is asked of the
 * network.
 */
export const KEPT_TOKEN_EVERY_MS = 5_000;

/** Whose a token is: the television and its home. A fresh token for the same television says the same. */
export interface Whose {
  readonly deviceId: string;
  readonly householdId: string;
}

/**
 * Why a hold ended. `retake`: the app now keeps the token of another
 * television or another home — paired again — and the connection is to be
 * taken up anew with it. `over`: nothing to hold — not paired, a family
 * member's television, disconnected, the token let go, or stopped.
 */
export type HoldEnd = 'over' | 'retake';

export interface DoorHold {
  /** Settles when the connection is let go, saying why. */
  readonly done: Promise<HoldEnd>;
  /** Whose token the connection is held with, once there is one. */
  holding(): Whose | undefined;
  stop(): void;
}

/** A disk for cards that keeps nothing: what the service is sent lives as long as the service does. */
const keepsNothing: FileSystemLike = {
  exists: async () => false,
  readFileAsString: async () => '',
  writeStringToFile: async (_path, content) => content.length,
};

/**
 * Whose television the app holds now, by the token it keeps — or nothing:
 * no token, one that cannot be read, or a family member's (which this
 * service never holds).
 */
export async function keptWhose(fs: FileSystemLike): Promise<Whose | undefined> {
  try {
    if (!(await fs.exists(TOKEN_PATH))) return undefined;
    const kept = JSON.parse(await fs.readFileAsString(TOKEN_PATH, 'utf8')) as Partial<DeviceToken> | null;
    if (typeof kept?.jwt !== 'string' || !kept.jwt || typeof kept.deviceId !== 'string' || typeof kept.householdId !== 'string') return undefined;
    if (televisionMode(kept as DeviceToken) !== 'resident') return undefined;
    return { deviceId: kept.deviceId, householdId: kept.householdId };
  } catch {
    return undefined;
  }
}

const sameTelevision = (a: Whose, b: Whose): boolean => a.deviceId === b.deviceId && a.householdId === b.householdId;

/** Her language as the app last kept it; English where it has kept none. */
export async function rememberedLanguage(fs: FileSystemLike): Promise<HouseholdLanguage> {
  try {
    if (!(await fs.exists(LANGUAGE_PATH))) return 'en';
    const parsed: unknown = JSON.parse(await fs.readFileAsString(LANGUAGE_PATH, 'utf8'));
    return isHouseholdLanguage(parsed) ? parsed : 'en';
  } catch {
    return 'en';
  }
}

export function holdDoor(deps: DoorServiceDeps): DoorHold {
  const now = deps.now ?? Date.now;
  const createChannel = deps.createChannel ?? createDeviceChannel;
  let release: (end: HoldEnd) => void = () => undefined;
  const done = new Promise<HoldEnd>((resolve) => {
    release = resolve;
  });
  let over = false;
  let inUse: DeviceToken | undefined;
  let letGo: () => void = () => undefined;
  const clear = (cardId: string): void => {
    void deps.alerts.clear(cardId).catch((err: unknown) => console.error('door_alert_clear_failed', err));
  };
  /** The door notifications this hold has put up: they are its home's, and go with it. */
  const shown = new Set<string>();
  const end = (why: HoldEnd): void => {
    if (over) return;
    over = true;
    inUse = undefined;
    letGo();
    for (const cardId of shown) clear(cardId);
    shown.clear();
    release(why);
  };
  const stop = (): void => end('over');

  // Best effort, and silent: a notification that cannot be put up must not take the connection down with it.
  // The card is stored on the server, and is on screen the next time Wick is.
  const show = (card: QueuedCard): void => {
    void (async () => {
      const alert = doorAlert(card, await rememberedLanguage(deps.fs), now());
      // Looked at again after the language is read: a hold let go in between posts nothing.
      if (!alert || over) return;
      shown.add(alert.cardId);
      await deps.alerts.show(alert);
    })().catch((err: unknown) => console.error('door_alert_failed', err));
  };
  // The background channel itself lets a taken-back card go from its store (startBackgroundChannel); this also
  // takes its notification down. The same channel, listened to once more.
  const watchingRevokes: ChannelFactory = async (config, token) => {
    const channel = await createChannel(config, token);
    channel.onControl((msg) => {
      if (msg.t !== 'revoke') return;
      shown.delete(msg.cardId);
      clear(msg.cardId);
    });
    return channel;
  };

  void (async () => {
    const pairing = new PairingFlow({ pairingApiUrl: deps.config.pairingApiUrl }, deps.fs, deps.fetchImpl, televisionIdentity(deps.fs));
    const deviceId = await resolveDeviceId(deps.fs);
    const before = await pairing.rememberedToken();
    const token = await pairing.loadToken(deviceId, { waitIfRefreshedJustNow: true });
    if (over) return;
    if (!token || televisionMode(token) !== 'resident') {
      console.info('door_service_nothing_to_hold');
      stop();
      return;
    }

    const store = new QueueStore(keepsNothing);
    const hold = (next: DeviceToken): RunningCardChannel => {
      inUse = next;
      return holdCardChannel(store, next, watchingRevokes, deps.config, show, undefined, () => standing.trouble());
    };
    let channel: RunningCardChannel | undefined;
    // As the Vega card service does: a television the family has disconnected looks, from a connection, like one
    // whose network has gone, so its trouble is asked about; and a token near its end is renewed with the answer.
    const standing = standingWatch({
      held: { token, ...(token.jwt !== before?.jwt ? { since: now() } : {}) },
      ask: (held) => pairing.renew(held.deviceId, held.jwt, { remember: false }),
      onGone: stop,
      onFresh: (fresh) => {
        channel?.stop();
        channel = hold(fresh);
      },
    });
    // The app forgets its token when the family disconnects the television, and keeps another when it is paired
    // again: either way the home this connection is for is no longer the television's.
    const looking = setInterval(() => {
      void keptWhose(deps.fs).then((kept) => {
        const held = inUse;
        if (over || !held) return;
        if (!kept) end('over');
        else if (!sameTelevision(kept, held)) end('retake');
      });
    }, deps.keptEveryMs ?? KEPT_TOKEN_EVERY_MS);
    letGo = () => {
      clearInterval(looking);
      standing.stop();
      channel?.stop();
    };
    channel = hold(token);
  })().catch((err: unknown) => {
    console.error('door_service_failed', err);
    stop();
  });

  return {
    done,
    holding: () => (inUse ? { deviceId: inUse.deviceId, householdId: inUse.householdId } : undefined),
    stop,
  };
}

export interface DoorRunner {
  /** The Headless JS task: settles when nothing is left to hold. Asked again while it runs, it gives the same. */
  run(): Promise<void>;
  /**
   * Wick is on screen, holding the token of `now`. A connection held for
   * another television or another home — the app was paired again, as a new
   * television, while the service held the old one — is let go and taken
   * up again with the token the app keeps now. (The hold notices by itself
   * too, within KEPT_TOKEN_EVERY_MS; this is at once.)
   */
  reconsider(now: Whose): void;
  /** The app keeps no token: the connection is let go, its notifications taken down, and the task ends. */
  stop(): void;
}

/** One hold at a time for the life of the task, taken up again when the app's television is no longer the one held. */
export function doorRunner(start: () => DoorHold): DoorRunner {
  let current: DoorHold | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  const begin = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const next = (): void => {
        const hold = start();
        current = hold;
        void hold.done.then((why) => {
          if (current !== hold) return;
          if (again || why === 'retake') {
            again = false;
            next();
            return;
          }
          current = undefined;
          running = undefined;
          resolve();
        });
      };
      next();
    });
  return {
    run() {
      running ??= begin();
      return running;
    },
    reconsider(now) {
      const held = current?.holding();
      if (!current || !held || sameTelevision(held, now)) return;
      again = true;
      current.stop();
    },
    stop() {
      again = false;
      current?.stop();
    },
  };
}
