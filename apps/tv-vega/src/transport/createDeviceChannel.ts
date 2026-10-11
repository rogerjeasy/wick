/**
 * SP-5 resolved as runtime behaviour rather than a static choice: no Vega
 * hardware was available to run the documented 4-hour spike
 * (docs/WICK-TECHNICAL.md §14 SP-5), so both implementations ship and this
 * factory tries IoT Core MQTT first, falling back to the WebSocket API on any
 * connect failure or timeout — every time the app starts, not just once.
 * Both halves were seen on the Vega simulator on 2026-10-11 (FRICTION.md
 * FL-009, update).
 */
import type { DeviceChannel, DeviceToken } from '@wick/contracts';
import { MqttChannel, type MqttChannelConfig, type MqttConnector } from './MqttChannel.js';
import { WebSocketChannel, type WebSocketChannelConfig, type WebSocketFactory } from './WebSocketChannel.js';

export interface DeviceChannelConfig {
  /** Absent, MQTT is never tried: the card service, which holds the WebSocket's background slot. */
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
      // Falls through to B (docs/WICK-TECHNICAL.md §4.1).
    }
  }
  const wsChannel = overrides.websocketOpen
    ? new WebSocketChannel(config.websocket, overrides.websocketOpen)
    : new WebSocketChannel(config.websocket);
  try {
    await wsChannel.connect(token);
  } catch (err) {
    // The caller never gets this instance, so nothing could ever close it —
    // and its own backoff would keep reconnecting, taking over this device's
    // connectionId (last connect wins, connect.mjs) with no handler attached.
    wsChannel.close();
    throw err;
  }
  return wsChannel;
}
