/**
 * Option B — API Gateway WebSocket. Zero library risk: RN ships a standard
 * WebSocket. Auth travels in the connect URL's query string (`?token=`)
 * because RN's WebSocket cannot set arbitrary connect-time headers.
 *
 * Reconnect: exponential backoff 1s -> 30s, full jitter. On open, reconcile:
 * send lastSeenCardId, receive everything after it — except on the card
 * service's background connection, which only listens (see `role`).
 */
import type {
  ChannelState,
  ControlMessage,
  DeviceChannel,
  DeviceEvent,
  DeviceToken,
  DeviceWireMessage,
  QueuedCard,
  Unsubscribe,
} from '@wick/contracts';

export type WebSocketFactory = (url: string) => WebSocket;

export interface WebSocketChannelConfig {
  readonly url: string;
  readonly getLastSeenCardId?: () => string | undefined | Promise<string | undefined>;
  /**
   * 'background' for the card service's connection: the server keeps it
   * apart from the app's own (edge-device connection-slot.mjs) and sends to
   * it only while the app is not on screen. It never reconciles — a replay
   * is for a screen that can show cards, and the service would announce
   * every card still waiting as if somebody had just rung.
   */
  readonly role?: 'background';
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

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

  #openSocket(): Promise<void> {
    this.#state = 'connecting';
    const token = this.#token!;
    const role = this.#config.role ? `&role=${this.#config.role}` : '';
    const url = `${this.#config.url}?token=${encodeURIComponent(token.jwt)}${role}`;

    return new Promise((resolve, reject) => {
      const socket = this.#open(url);
      this.#socket = socket;
      let settled = false;

      socket.onopen = () => {
        void (async () => {
          this.#state = 'open';
          this.#backoffMs = MIN_BACKOFF_MS;
          if (this.#config.role !== 'background') {
            const sinceCardId = await this.#config.getLastSeenCardId?.();
            socket.send(JSON.stringify({ t: 'reconcile', sinceCardId }));
          }
          if (!settled) {
            settled = true;
            resolve();
          }
        })();
      };

      socket.onmessage = (ev: { data: unknown }) => {
        const msg = JSON.parse(String(ev.data)) as DeviceWireMessage;
        if (msg.kind === 'card') {
          for (const h of this.#cardHandlers) h(msg.card);
        } else {
          for (const h of this.#controlHandlers) h(msg.control);
        }
      };

      socket.onclose = () => {
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

  #scheduleReconnect(): void {
    const delay = Math.random() * this.#backoffMs; // full jitter: uniform(0, current backoff)
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => void this.#openSocket(), delay);
  }
}
