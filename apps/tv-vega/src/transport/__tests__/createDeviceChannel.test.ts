import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DeviceToken } from '@wick/contracts';
import { createDeviceChannel } from '../createDeviceChannel.js';
import { MqttChannel, type MqttConnector } from '../MqttChannel.js';
import { WebSocketChannel, type WebSocketFactory } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 1000 };

function workingMqttConnector(): MqttConnector {
  return () => {
    const client = Object.assign(new EventEmitter(), {
      subscribe: (_t: string[], _o: unknown, cb: (e?: Error) => void) => cb(),
      publish: (_t: string, _p: string, _o: unknown, cb: (e?: Error) => void) => cb(),
      end: () => undefined,
    });
    queueMicrotask(() => client.emit('connect'));
    return client as unknown as ReturnType<MqttConnector>;
  };
}

function brokenMqttConnector(): MqttConnector {
  return () => {
    // Never emits 'connect' -> MqttChannel's connect timeout fires and calls
    // client.end(true), so the fake needs that method even though it's a no-op.
    const client = Object.assign(new EventEmitter(), { end: () => undefined });
    return client as unknown as ReturnType<MqttConnector>;
  };
}

function workingWsFactory(): WebSocketFactory {
  return (url: string) => {
    const socket = {
      url,
      onopen: null as (() => void) | null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    };
    queueMicrotask(() => socket.onopen?.());
    return socket as unknown as WebSocket;
  };
}

describe('createDeviceChannel', () => {
  it('returns MqttChannel when MQTT connects', async () => {
    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt' }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { mqttConnect: workingMqttConnector(), websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(MqttChannel);
  });

  it('falls back to WebSocketChannel when MQTT times out', async () => {
    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 10 }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { mqttConnect: brokenMqttConnector(), websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(WebSocketChannel);
  });

  it('goes straight to WebSocketChannel when config.mqtt is absent', async () => {
    const channel = await createDeviceChannel(
      { websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(WebSocketChannel);
  });
});
