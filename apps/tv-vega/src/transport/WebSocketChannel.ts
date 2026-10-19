/**
 * Option B — API Gateway WebSocket. Zero library risk: RN ships a standard
 * WebSocket. Auth travels in the connect URL's query string (`?token=`)
 * because RN's WebSocket cannot set arbitrary connect-time headers.
 *
 * Reconnect: exponential backoff 1s -> 30s, full jitter. On open, reconcile:
 * send lastSeenCardId, receive everything after it — except on the card
 * service's background connection, which only listens (see `role`). The
 * same request can be made again while connected (`reconcile`): the card
 * channel does, when her language changes (startCardChannel.ts).
 *
 * A connection can die without saying so: Wi-Fi gone, a router restarted, a
 * NAT that forgot the socket. Nothing closes, and a door card never comes.
 * So while it is open the channel asks the edge `ping` every `heartbeatMs`
 * and expects anything at all back within `pongWaitMs` (the edge answers
 * `pong`, route.mjs; a card or a control message is as good). Silence is a
 * dead connection: it is let go and a new one is made, with the same
 * backoff as any other.
 */
import { readWireMessage } from './wire.js';
import type {
  ChannelState,
  ControlMessage,
  DeviceChannel,
  DeviceEvent,
  DeviceToken,
  QueuedCard,
  Unsubscribe,
} from '@wick/contracts';

export type WebSocketFactory = (url: string) => WebSocket;

export interface WebSocketChannelConfig {
  readonly url: string;
  readonly getLastSeenCardId?: () => string | undefined | Promise<string | undefined>;
  /**
   * The cards this television holds, sent with the reconcile: the server
   * takes back any that were answered on another television in the home.
   */
  readonly getHeldCardIds?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * 'background' for the card service's connection: the server keeps it
   * apart from the app's own (edge-device connection-slot.mjs) and sends to
   * it only while the app is not on screen. It never reconciles — a replay
   * is for a screen that can show cards, and the service would announce
   * every card still waiting as if somebody had just rung.
   */
  readonly role?: 'background';
  /** How often an open connection is asked whether it still reaches the edge. Default 45 s. */
  readonly heartbeatMs?: number;
  /** How long an answer to that may take before the connection is given up. Default 15 s. */
  readonly pongWaitMs?: number;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 45_000;
const DEFAULT_PONG_WAIT_MS = 15_000;

export class WebSocketChannel implements DeviceChannel {
  readonly #config: WebSocketChannelConfig;
  readonly #open: WebSocketFactory;
  #socket: WebSocket | undefined;
  #state: ChannelState = 'closed';
  #token: DeviceToken | undefined;
  readonly #cardHandlers = new Set<(c: QueuedCard) => void>();
  readonly #controlHandlers = new Set<(m: ControlMessage) => void>();
  #backoffMs = MIN_BACKOFF_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: WebSocketChannelConfig, open: WebSocketFactory = (url) => new WebSocket(url)) {
    this.#config = config;
    this.#open = open;
  }

  get state(): ChannelState {
    return this.#state;
  }

  connect(token: DeviceToken): Promise<void> {
    // Guard against overlapping connections: clear pending reconnect timer
    // and close/discard any existing socket before opening a new one.
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    // Temporarily set #closing to prevent onclose from scheduling another reconnect.
    const wasClosing = this.#closing;
    this.#closing = true;
    this.#socket?.close();
    this.#closing = wasClosing;

    this.#token = token;
    this.#closing = false;
    this.#backoffMs = MIN_BACKOFF_MS;
    return this.#openSocket();
  }

  close(): void {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHeartbeat();
    this.#socket?.close();
    this.#state = 'closed';
  }

  onCard(handler: (c: QueuedCard) => void): Unsubscribe {
    this.#cardHandlers.add(handler);
    return () => this.#cardHandlers.delete(handler);
  }

  onControl(handler: (m: ControlMessage) => void): Unsubscribe {
    this.#controlHandlers.add(handler);
    return () => this.#controlHandlers.delete(handler);
  }

  async send(e: DeviceEvent): Promise<void> {
    if (!this.#socket || this.#state !== 'open') throw new Error('not_connected');
    this.#socket.send(JSON.stringify(e));
  }

  /**
   * Asks for this television's cards again, as on connecting. Sends nothing
   * when it is not connected — connecting asks anyway — and never on the
   * card service's connection.
   */
  async reconcile(): Promise<void> {
    const socket = this.#socket;
    if (!socket || this.#state !== 'open') return;
    await this.#reconcileOn(socket);
  }

  async #reconcileOn(socket: WebSocket): Promise<void> {
    if (this.#config.role === 'background') return;
    const sinceCardId = await this.#config.getLastSeenCardId?.();
    const holding = await this.#config.getHeldCardIds?.();
    socket.send(JSON.stringify({ t: 'reconcile', sinceCardId, ...(holding ? { holding } : {}) }));
  }

  #openSocket(): Promise<void> {
    this.#state = 'connecting';
    const token = this.#token!;
    const role = this.#config.role ? `&role=${this.#config.role}` : '';
    const url = `${this.#config.url}?token=${encodeURIComponent(token.jwt)}${role}`;

    return new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = this.#open(url);
      } catch (err) {
        // A socket that cannot even be made is a failed attempt like any other.
        this.#state = this.#closing ? 'closed' : 'backoff';
        if (!this.#closing) this.#scheduleReconnect();
        reject(err instanceof Error ? err : new Error('websocket_not_made'));
        return;
      }
      this.#socket = socket;
      let settled = false;

      socket.onopen = () => {
        void (async () => {
          this.#state = 'open';
          this.#backoffMs = MIN_BACKOFF_MS;
          this.#startHeartbeat(socket);
          try {
            await this.#reconcileOn(socket);
          } catch (err) {
            // The reconcile is asked again on the next connection; a socket that is truly broken closes by itself.
            console.warn('websocket_reconcile_failed', err);
          }
          if (!settled) {
            settled = true;
            resolve();
          }
        })();
      };

      // `data` is optional in React Native's own WebSocket types (the Fire OS
      // build checks this file against them); wire.ts reads it either way.
      socket.onmessage = (ev: { data?: unknown }) => {
        // Anything at all from the edge shows the connection is alive.
        if (this.#socket === socket) this.#heardFromEdge();
        const msg = readWireMessage(ev.data);
        if (!msg) return;
        if (msg.kind === 'card') {
          for (const h of this.#cardHandlers) h(msg.card);
        } else if (msg.control.t !== 'pong') {
          for (const h of this.#controlHandlers) h(msg.control);
        }
      };

      socket.onclose = () => {
        // A socket this channel has already let go of (a dead one, or one replaced by connect) closes late: not news.
        if (this.#socket !== socket) {
          if (!settled) {
            settled = true;
            reject(new Error('websocket_closed_before_open'));
          }
          return;
        }
        this.#stopHeartbeat();
        this.#state = this.#closing ? 'closed' : 'backoff';
        if (!settled) {
          settled = true;
          reject(new Error('websocket_closed_before_open'));
        }
        if (!this.#closing) this.#scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose always follows onerror on both RN and browser WebSocket.
      };
    });
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat();
    const every = this.#config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const wait = this.#config.pongWaitMs ?? DEFAULT_PONG_WAIT_MS;
    this.#heartbeat = setInterval(() => {
      if (this.#socket !== socket || this.#state !== 'open') return;
      try {
        socket.send(JSON.stringify({ t: 'ping' }));
      } catch {
        this.#declareDead(socket);
        return;
      }
      // One question at a time: an answer still owed is the one being waited for.
      this.#pongTimer ??= setTimeout(() => this.#declareDead(socket), wait);
    }, every);
  }

  #heardFromEdge(): void {
    clearTimeout(this.#pongTimer);
    this.#pongTimer = undefined;
  }

  #stopHeartbeat(): void {
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#heardFromEdge();
  }

  /**
   * The connection answers nothing: let it go without waiting for a close
   * that, on a half-open socket, may never come, and make another.
   */
  #declareDead(socket: WebSocket): void {
    if (this.#socket !== socket || this.#closing) return;
    console.warn('websocket_silent — reconnecting');
    this.#stopHeartbeat();
    this.#socket = undefined;
    this.#state = 'backoff';
    try {
      socket.close();
    } catch {
      // Already gone.
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const delay = Math.random() * this.#backoffMs; // full jitter: uniform(0, current backoff)
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    // An attempt that fails has already scheduled the next one (onclose, or the catch in #openSocket):
    // its rejection is for connect()'s caller, and for nobody here.
    this.#reconnectTimer = setTimeout(() => void this.#openSocket().catch(() => undefined), delay);
  }
}
