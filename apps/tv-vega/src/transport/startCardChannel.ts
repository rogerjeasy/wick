/**
 * The card channel's working half: an already-connected DeviceChannel wired
 * to a QueueStore. Inbound cards and controls go into the store; outbound
 * device events the UI queued — among them `card_shown`, when a card is
 * really on screen — go out on a poll.
 *
 * Process-agnostic on purpose. It used to live inside CardService.ts, which
 * only ever runs in the card_service process — and on the VVD that process
 * never launches at all (FRICTION.md FL-014), so no card ever reached the
 * screen. App.tsx now runs this in the main process, against the same
 * QueueStore instance its render loop reads; CardService.ts still runs it
 * for the background case, wherever the platform does start that service.
 *
 * startCardChannel only ever sees a channel that already opened once — the
 * channel handles its own reconnects after that. holdCardChannel (below) is
 * the connect-and-retry wrapper App.tsx uses to get there.
 *
 * Her language (packages/contracts language.ts) reaches the television on
 * the `home` message and nowhere else. When it changes while the app is
 * running — she has just said yes on the card that asks — the cards this
 * television holds are still in the language she had, so the server is
 * asked for them again, once: the same reconcile each transport makes when
 * it connects, which sends every card she has not answered. Each one takes
 * the place of the one held under its id, and what was counted of its
 * showings is kept (QueueStore.upsert).
 */
import { readMantelItems, type ControlMessage, type DeviceEvent, type DeviceToken, type QueuedCard } from '@wick/contracts';
import type { QueueStore } from '../headless/QueueStore.js';
import { worthSending } from '../home/asked.js';
import type { DeviceConfig } from '../config.js';
import type { DeviceChannelConfig } from './createDeviceChannel.js';
import type { ReconcilingChannel } from './DeviceChannel.js';

const OUTBOX_POLL_MS = 1000;
const FIRST_CONNECT_MIN_RETRY_MS = 2000;
const FIRST_CONNECT_MAX_RETRY_MS = 30_000;
/** How often a channel that has been open is looked at, to say when it no longer is. */
const STATE_WATCH_MS = 1000;

export type ChannelFactory = (config: DeviceChannelConfig, token: DeviceToken) => Promise<ReconcilingChannel>;

/**
 * Told of each event as it really leaves the television, and when. The app
 * uses it for the two events that are questions — her hold on OK, her press
 * on the light — whose answer it waits for from this moment (home/asked.ts).
 */
export type SentObserver = (event: DeviceEvent, at: number) => void;

export interface RunningCardChannel {
  /** Closes the channel and stops flushing. Idempotent. */
  stop(): void;
  /**
   * Asks the server for this television's cards again — the request the
   * channel makes by itself when it connects. For the app, when a picture
   * card's address has run out (mantel/mantel.ts pictureRefresher): the
   * server sends the card back with a new one. Does nothing when there is
   * no connection to ask on, and never throws.
   */
  reconcile(): void;
}

export function startCardChannel(store: QueueStore, channel: ReconcilingChannel, onSent?: SentObserver): RunningCardChannel {
  // Stored, not announced as shown: a card that arrives is not yet on
  // screen — a note waits for a natural break. App.tsx says `card_shown`
  // when it is (BreakController.noteShown), which is what the server counts
  // towards the two showings a card gets.
  const unsubscribeCard = channel.onCard((card: QueuedCard) => {
    void store.upsert(card);
  });

  const unsubscribeControl = channel.onControl((msg: ControlMessage) => {
    if (msg.t === 'patch') void store.applyPatch(msg.patch);
    else if (msg.t === 'revoke') void store.remove(msg.cardId);
    // Her light, who looked in, and the language she chose: for the home screen, not a card.
    else if (msg.t === 'home') {
      const { languageChanged } = store.setHome(msg.home, { whole: msg.whole === true });
      // The cards held are in the language she had: ask for them again, in the one she has now.
      // Once per change — the answer brings the home again, in the same language, and that is no change.
      if (languageChanged) void channel.reconcile?.().catch(() => undefined);
    }
    // Her mantelpiece, answered to this television's own asking (packages/contracts mantel.ts): only what is
    // well formed, kept in memory with the moment it came — the addresses in it are good for an hour.
    else if (msg.t === 'mantel') store.setMantel(readMantelItems(msg.items), Date.now());
    // The reading she asked for (packages/contracts speech.ts): handed to the app as it arrives, and kept nowhere.
    else if (msg.t === 'speech' && typeof msg.cardId === 'string') store.heardSpeech(msg.cardId, typeof msg.url === 'string' ? msg.url : undefined);
  });

  let flushing = false;
  const outboxTimer = setInterval(() => {
    // One flush at a time: a slow send must not let the next tick drain the
    // same outbox a second time and reorder events.
    if (flushing || channel.state !== 'open') return;
    flushing = true;
    void flushOutbox(store, channel, onSent).finally(() => {
      flushing = false;
    });
  }, OUTBOX_POLL_MS);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(outboxTimer);
      unsubscribeCard();
      unsubscribeControl();
      channel.close();
    },
    reconcile() {
      if (stopped) return;
      void channel.reconcile?.().catch(() => undefined);
    },
  };
}

/**
 * The card service's half, behind another app: listen, keep the store in
 * step, and announce. It shows nothing itself, so it never says
 * `card_shown` — that is the app's to say, when the card is on screen —
 * and it leaves the outbox to the app, whose events those are.
 *
 * A door card is announced twice at most: when it arrives, and once more
 * when the door agent's description of who is there arrives for it — by
 * then usually with the picture (door agent, Phase 2). The picture alone
 * is not announced, nor anything later (the chime rang, the buttons
 * changed): a second toast is for when there is something new to say
 * about who is at the door.
 */
export function startBackgroundChannel(
  store: QueueStore,
  channel: ReconcilingChannel,
  announce: (card: QueuedCard) => void,
): RunningCardChannel {
  // One at a time, in the order they arrived: a patch must find the card
  // it is for already stored, and be applied before the card is read back.
  let tail: Promise<void> = Promise.resolve();
  const inOrder = (work: () => Promise<void>): void => {
    tail = tail.then(work).catch(() => undefined);
  };
  const described = new Set<string>();

  const unsubscribeCard = channel.onCard((card: QueuedCard) => {
    // Best effort: the VVD has no data root (FL-013), and the store falls
    // back to memory. The server still holds the card, and replays it when
    // the app next connects.
    inOrder(() => store.upsert(card));
    announce(card);
  });

  const unsubscribeControl = channel.onControl((msg: ControlMessage) => {
    if (msg.t === 'revoke') {
      inOrder(() => store.remove(msg.cardId));
      return;
    }
    if (msg.t !== 'patch') return;
    const { patch } = msg;
    inOrder(async () => {
      await store.applyPatch(patch);
      if (patch.description === undefined || described.has(patch.cardId)) return;
      const card = (await store.readAll()).find((c) => c.id === patch.cardId);
      // Not one this process holds: the app was on screen when it came.
      if (!card) return;
      described.add(patch.cardId);
      announce(card);
    });
  });

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeCard();
      unsubscribeControl();
      channel.close();
    },
    // It shows no card, so it never asks for them: a replay would be announced as if somebody had just rung.
    reconcile() {},
  };
}

async function flushOutbox(store: QueueStore, channel: ReconcilingChannel, onSent?: SentObserver): Promise<void> {
  const events = await store.drainOutbound();
  for (const event of events) {
    // A question that has waited too long to leave is not sent late: the
    // server would answer it as if she had just asked (home/asked.ts).
    if (!worthSending(event, Date.now())) continue;
    try {
      await channel.send(event);
    } catch {
      await store.enqueueOutbound(event); // best-effort — retried next tick
      continue;
    }
    onSent?.(event, Date.now());
  }
}

/**
 * Connect, then run — App.tsx's whole side of the channel, and with
 * `announce` the card service's. A failed first
 * connect (no network yet at boot, API Gateway briefly unreachable) retries
 * with capped backoff: once the device is paired there is no screen to fall
 * back to, so giving up would mean no cards until the next relaunch. After
 * the first successful connect the channel's own reconnect takes over.
 */
export function holdCardChannel(
  store: QueueStore,
  token: DeviceToken,
  createChannel: ChannelFactory,
  config: Pick<DeviceConfig, 'websocketUrl' | 'mqttWssUrl'>,
  /** Given by the card service: hold the background connection, and announce instead of show. */
  announce?: (card: QueuedCard) => void,
  /** Given by the app: told of each event as it leaves. The card service sends none. */
  onSent?: SentObserver,
  /**
   * Told when the channel is in trouble: each time a connection is refused
   * or cannot be made, and every second that a channel which was open is
   * not. From here a television the family has disconnected looks exactly
   * like one whose network has gone — so whoever is told asks the pairing
   * service which it is (pairing/standing.ts). This only says; the channel
   * goes on trying as it always did.
   */
  onTrouble?: () => void,
): RunningCardChannel {
  // What a reconcile says of this television: the last card it saw, and the ones it holds.
  const reconcileWith = {
    getLastSeenCardId: () => store.lastSeenCardId(),
    getHeldCardIds: async () => (await store.readAll()).map((c) => c.id),
  };
  const channelConfig: DeviceChannelConfig = announce
    ? { websocket: { url: config.websocketUrl, role: 'background' } }
    : {
        websocket: { url: config.websocketUrl, ...reconcileWith },
        ...(config.mqttWssUrl ? { mqtt: { wssUrl: config.mqttWssUrl, ...reconcileWith } } : {}),
      };

  let stopped = false;
  let running: RunningCardChannel | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = FIRST_CONNECT_MIN_RETRY_MS;
  let stateWatch: ReturnType<typeof setInterval> | undefined;

  const attempt = async (): Promise<void> => {
    let channel: ReconcilingChannel;
    try {
      channel = await createChannel(channelConfig, token);
    } catch (err) {
      if (stopped) return;
      console.error('card_channel_connect_failed — retrying', { retryMs }, err);
      onTrouble?.();
      retryTimer = setTimeout(() => void attempt(), retryMs);
      retryMs = Math.min(retryMs * 2, FIRST_CONNECT_MAX_RETRY_MS);
      return;
    }
    if (stopped) {
      channel.close(); // stop() won the race — never leave it holding this device's connectionId
      return;
    }
    running = announce ? startBackgroundChannel(store, channel, announce) : startCardChannel(store, channel, onSent);
    // From here the channel reconnects by itself, and says nothing of being refused: its state is all there is to go by.
    if (onTrouble) {
      stateWatch = setInterval(() => {
        if (channel.state !== 'open') onTrouble();
      }, STATE_WATCH_MS);
    }
  };
  void attempt();

  return {
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(stateWatch);
      running?.stop();
      running = undefined;
    },
    // Not connected yet, or let go: there is nothing to ask on, and connecting asks anyway.
    reconcile() {
      running?.reconcile();
    },
  };
}
