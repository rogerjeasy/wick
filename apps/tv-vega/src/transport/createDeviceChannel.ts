/**
 * SP-5 resolved as runtime behaviour rather than a static choice: no Vega
 * hardware was available to run the documented 4-hour spike
 * (docs/WICK-TECHNICAL.md §14 SP-5), so both implementations ship and this
 * factory tries IoT Core MQTT first, falling back to the WebSocket API on any
 * connect failure or timeout — every time the app starts, not just once. See
 * the plan's Scope decisions and FRICTION.md for why IoT Core infra isn't
 * live yet.
 */
import type { DeviceChannel, DeviceToken } from '@wick/contracts';
import { MqttChannel, type MqttChannelConfig, type MqttConnector } from './MqttChannel.js';
import { WebSocketChannel, type WebSocketChannelConfig, type WebSocketFactory } from './WebSocketChannel.js';

export interface DeviceChannelConfig {
  /** Absent until infra/transport.tf's IoT Core stack is deployed. */
  readonly mqtt?: MqttChannelConfig;
  readonly websocket: WebSocketChannelConfig;
}

export interface DeviceChannelOverrides {
  readonly mqttConnect?: MqttConnector;
  readonly websocketOpen?: WebSocketFactory;
}

export async function createDeviceChannel(
  config: DeviceChannelConfig,
  token: DeviceToken,
  overrides: DeviceChannelOverrides = {},
): Promise<DeviceChannel> {
  if (config.mqtt) {
    const mqttChannel = overrides.mqttConnect
      ? new MqttChannel(config.mqtt, overrides.mqttConnect)
      : new MqttChannel(config.mqtt);
    try {
      await mqttChannel.connect(token);
      return mqttChannel;
    } catch {
      // Falls through to B. The first time this actually fires on hardware is
      // a FRICTION.md entry, not a silent path — see docs/WICK-TECHNICAL.md §14.
    }
  }
  const wsChannel = overrides.websocketOpen
    ? new WebSocketChannel(config.websocket, overrides.websocketOpen)
    : new WebSocketChannel(config.websocket);
  await wsChannel.connect(token);
  return wsChannel;
}
