/**
 * Option A — AWS IoT Core, MQTT over WSS.
 *
 * Wraps `mqtt.connect()`. Per-device topics keep an IoT policy scoped to
 * exactly what one device needs:
 *   wick/device/<id>/cards    — QueuedCard, QoS 1
 *   wick/device/<id>/control  — ControlMessage, QoS 1
 *   wick/device/<id>/events   — DeviceEvent, published by the device
 *
 * QoS 1 + a persistent session (`clean: false`) is the whole reason to prefer
 * this over WebSocketChannel: a card sent while the connection was down is
 * held by the broker and arrives on reconnect.
 *
 * The device token travels in the address (`?token=`), as it does on the
 * WebSocket, and not as the MQTT password. AWS only accepts credentials in
 * the MQTT CONNECT from a client that sets the ALPN TLS extension, and a
 * WebSocket opened from JavaScript cannot (AWS IoT custom authentication,
 * "MQTT over WebSockets"; FRICTION.md). The authorizer the address names
 * (edge-device iot-authorize.mjs) answers with a policy for this
 * television's id and its three topics, so the client id must be that id.
 *
 * On every connection it asks for the cards it is owed, as WebSocketChannel
 * does: the broker's held messages cover a short drop, the reconcile covers
 * everything else (a card sent while this television was on the WebSocket,
 * or before it was ever on MQTT).
 *
 * A first connection that fails is reported and not retried here —
 * createDeviceChannel.ts falls back to WebSocketChannel, and a client still
 * trying in the background would take the television's connection back from
 * it. Once a connection has been made, a drop is retried with the same
 * backoff WebSocketChannel uses.
 *
 * SP-5 (docs/WICK-TECHNICAL.md §14): see FRICTION.md FL-009 for what running
 * this on the Vega simulator found.
 */
import mqttLib, { type MqttClient } from 'mqtt';
import type {
  ChannelState,
  ControlMessage,
  DeviceChannel,
  DeviceEvent,
  DeviceToken,
  QueuedCard,
  Unsubscribe,
} from '@wick/contracts';

export type MqttConnector = (url: string, options: Record<string, unknown>) => MqttClient;

export interface MqttChannelConfig {
  /** The IoT Core endpoint with the authorizer named: `wss://…/mqtt?x-amz-customauthorizer-name=…`. */
  readonly wssUrl: string;
  readonly connectTimeoutMs?: number;
  readonly getLastSeenCardId?: () => string | undefined | Promise<string | undefined>;
  /**
   * The cards this television holds, sent with the reconcile: the server
   * takes back any that were answered on another television in the home.
   */
  readonly getHeldCardIds?: () => readonly string[] | Promise<readonly string[]>;
}

interface Topics {
  readonly cards: string;
  readonly control: string;
  readonly events: string;
}

const topicsFor = (deviceId: string): Topics => ({
  cards: `wick/device/${deviceId}/cards`,
  control: `wick/device/${deviceId}/control`,
  events: `wick/device/${deviceId}/events`,
});

const DEFAULT_CONNECT_TIMEOUT_MS = 4000;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** The address to connect to: the configured one, with this television's token added. */
export function mqttUrl(wssUrl: string, jwt: string): string {
  return `${wssUrl}${wssUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(jwt)}`;
}

export class MqttChannel implements DeviceChannel {
  readonly #config: MqttChannelConfig;
  readonly #connect: MqttConnector;
  #client: MqttClient | undefined;
  #token: DeviceToken | undefined;
  #topics: Topics | undefined;
  #state: ChannelState = 'closed';
  readonly #cardHandlers = new Set<(c: QueuedCard) => void>();
  readonly #controlHandlers = new Set<(m: ControlMessage) => void>();
  #backoffMs = MIN_BACKOFF_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;

  constructor(config: MqttChannelConfig, connect: MqttConnector = mqttLib.connect) {
    this.#config = config;
    this.#connect = connect;
  }

  get state(): ChannelState {
    return this.#state;
  }

  close(): void {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#client?.end(true);
    this.#client = undefined;
    this.#state = 'closed';
  }

  connect(token: DeviceToken): Promise<void> {
    // Guard against overlapping connections, same as WebSocketChannel.connect():
    // drop any pending reconnect and end any existing client before opening a
    // new one, so a second connect() can't leak the first client's socket/timers.
    clearTimeout(this.#reconnectTimer);
    this.#closing = true;
    this.#client?.end(true);
    this.#client = undefined;

    this.#token = token;
    this.#topics = topicsFor(token.deviceId);
    this.#closing = false;
    this.#backoffMs = MIN_BACKOFF_MS;
    return this.#open({ first: true });
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
    const client = this.#client;
    const topics = this.#topics;
    if (!client || !topics || this.#state !== 'open') throw new Error('not_connected');
    await publish(client, topics.events, JSON.stringify(e));
  }

  /**
   * Asks for this television's cards again, as on connecting: the card
   * channel does, when her language changes (startCardChannel.ts).
   * Publishes nothing when it is not connected — connecting asks anyway.
   */
  async reconcile(): Promise<void> {
    const client = this.#client;
    const topics = this.#topics;
    if (!client || !topics || this.#state !== 'open') return;
    await this.#reconcileOn(client, topics.events);
  }

  /** Best-effort: a reconcile that cannot be sent is asked again on the next connection. */
  async #reconcileOn(client: MqttClient, eventsTopic: string): Promise<void> {
    const sinceCardId = await this.#config.getLastSeenCardId?.();
    const holding = await this.#config.getHeldCardIds?.();
    await publish(client, eventsTopic, JSON.stringify({ t: 'reconcile', sinceCardId, ...(holding ? { holding } : {}) })).catch(() => undefined);
  }

  /**
   * One connection attempt. `first` is the attempt connect() made: its
   * failure is the caller's to act on. Every later one is this channel's own
   * retry, and a failure there schedules the next.
   */
  #open({ first }: { first: boolean }): Promise<void> {
    const token = this.#token!;
    const topics = this.#topics!;
    this.#state = 'connecting';

    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const client = this.#connect(mqttUrl(this.#config.wssUrl, token.jwt), {
        clientId: token.deviceId,
        clean: false,
        reconnectPeriod: 0, // reconnecting is done here, with a fresh address each time
      });
      this.#client = client;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.end(true);
        if (this.#client === client) this.#client = undefined;
        if (first) {
          this.#state = 'closed';
          reject(err);
        } else {
          // Our own retry: nobody is waiting on this promise for an answer.
          resolve();
          if (!this.#closing) this.#scheduleReconnect();
        }
      };

      const timeout = setTimeout(
        () => fail(new Error('mqtt_connect_timeout')),
        this.#config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );

      client.on('connect', () => {
        client.subscribe([topics.cards, topics.control], { qos: 1 }, (err) => {
          if (settled) return;
          if (err) {
            fail(err);
            return;
          }
          void (async () => {
            await this.#reconcileOn(client, topics.events);
            if (settled) return;
            settled = true;
            opened = true;
            clearTimeout(timeout);
            this.#state = 'open';
            this.#backoffMs = MIN_BACKOFF_MS;
            resolve();
          })();
        });
      });

      client.on('message', (topic: string, payload: Buffer) => {
        if (topic === topics.cards) {
          const card = JSON.parse(payload.toString('utf8')) as QueuedCard;
          for (const h of this.#cardHandlers) h(card);
        } else if (topic === topics.control) {
          const control = JSON.parse(payload.toString('utf8')) as ControlMessage;
          for (const h of this.#controlHandlers) h(control);
        }
      });

      client.on('close', () => {
        // Only a connection that was open is this handler's to retry; one
        // that never opened is `fail`'s, by the timeout or the error.
        if (!opened || this.#client !== client) return;
        opened = false;
        this.#client = undefined;
        if (this.#closing) {
          this.#state = 'closed';
          return;
        }
        this.#scheduleReconnect();
      });

      client.on('error', (err: Error) => fail(err));
    });
  }

  #scheduleReconnect(): void {
    this.#state = 'backoff';
    const delay = Math.random() * this.#backoffMs; // full jitter: uniform(0, current backoff)
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => void this.#open({ first: false }), delay);
  }
}

function publish(client: MqttClient, topic: string, body: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.publish(topic, body, { qos: 1 }, (err?: Error) => (err ? reject(err) : resolve()));
  });
}
