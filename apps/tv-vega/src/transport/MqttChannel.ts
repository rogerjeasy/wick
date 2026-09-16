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
 * this over WebSocketChannel: a card queued while the TV was off arrives on
 * reconnect without any application-level catch-up logic.
 *
 * SP-5 (docs/WICK-TECHNICAL.md §14): unproven inside Vega's RN 0.83 fork until
 * this runs on real hardware. createDeviceChannel.ts times this out and falls
 * back to WebSocketChannel — see FRICTION.md and the plan's Scope decisions.
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
  readonly wssUrl: string;
  readonly connectTimeoutMs?: number;
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

export class MqttChannel implements DeviceChannel {
  readonly #config: MqttChannelConfig;
  readonly #connect: MqttConnector;
  #client: MqttClient | undefined;
  #topics: Topics | undefined;
  #state: ChannelState = 'closed';
  readonly #cardHandlers = new Set<(c: QueuedCard) => void>();
  readonly #controlHandlers = new Set<(m: ControlMessage) => void>();

  constructor(config: MqttChannelConfig, connect: MqttConnector = mqttLib.connect) {
    this.#config = config;
    this.#connect = connect;
  }

  get state(): ChannelState {
    return this.#state;
  }

  connect(token: DeviceToken): Promise<void> {
    const topics = topicsFor(token.deviceId);
    this.#topics = topics;
    this.#state = 'connecting';

    return new Promise((resolve, reject) => {
      let settled = false;
      const client = this.#connect(this.#config.wssUrl, {
        username: token.deviceId,
        password: token.jwt,
        clientId: token.deviceId,
        clean: false,
        reconnectPeriod: 0, // WebSocketChannel-style backoff is owned by createDeviceChannel's caller, not here
      });
      this.#client = client;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#state = 'closed';
        client.end(true);
        reject(new Error('mqtt_connect_timeout'));
      }, this.#config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      client.on('connect', () => {
        this.#state = 'open';
        client.subscribe([topics.cards, topics.control], { qos: 1 }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve();
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
        this.#state = 'closed';
      });

      client.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
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
    if (!client || !topics) throw new Error('not_connected');
    await new Promise<void>((resolve, reject) => {
      client.publish(topics.events, JSON.stringify(e), { qos: 1 }, (err?: Error) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
