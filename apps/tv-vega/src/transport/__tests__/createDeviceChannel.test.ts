import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.useRealTimers();
});

describe('createDeviceChannel', () => {
  it('leaves no channel reconnecting behind when the first WebSocket connect fails', async () => {
    // The server keeps one connectionId per device, last connect wins
    // (connect.mjs). An orphan that the caller never got a handle to would
    // keep reconnecting and capture this device's cards with no handler
    // attached — every card after that silently dropped.
    vi.useFakeTimers();
    let opened = 0;
    const refusingFactory: WebSocketFactory = () => {
      opened++;
      const socket = {
        onopen: null,
        onmessage: null,
        onclose: null as (() => void) | null,
        onerror: null,
        send: () => undefined,
        close: () => undefined,
      };
      queueMicrotask(() => socket.onclose?.());
      return socket as unknown as WebSocket;
    };

    await expect(
      createDeviceChannel({ websocket: { url: 'wss://ws.example' } }, TOKEN, { websocketOpen: refusingFactory }),
    ).rejects.toThrow('websocket_closed_before_open');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(opened).toBe(1);
  });

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
  it('gives each channel to `attach` before it connects, so a screen hears its state from the first moment', async () => {
    const seen: Array<{ kind: string; state: string }> = [];
    const channel = await createDeviceChannel(
      {
        mqtt: { wssUrl: 'wss://iot.example/mqtt' },
        websocket: { url: 'wss://example/ws' },
        attach: (c) => {
          const kind = c instanceof MqttChannel ? 'mqtt' : 'websocket';
          seen.push({ kind, state: c.state });
          c.onState?.((state) => seen.push({ kind, state }));
        },
      },
      TOKEN,
      { mqttConnect: workingMqttConnector() },
    );

    expect(channel).toBeInstanceOf(MqttChannel);
    // Attached while still closed, then told of its connecting and its opening.
    expect(seen).toEqual([
      { kind: 'mqtt', state: 'closed' },
      { kind: 'mqtt', state: 'connecting' },
      { kind: 'mqtt', state: 'open' },
    ]);
  });

  it('attaches the WebSocket too when IoT Core was refused, after the first, and the one returned is the one attached last', async () => {
    vi.useFakeTimers();
    const attached: unknown[] = [];
    const pending = createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 50 }, websocket: { url: 'wss://example/ws' }, attach: (c) => attached.push(c) },
      TOKEN,
      { mqttConnect: brokenMqttConnector(), websocketOpen: workingWsFactory() },
    );
    await vi.advanceTimersByTimeAsync(100);
    const channel = await pending;

    expect(attached).toHaveLength(2);
    expect(attached[0]).toBeInstanceOf(MqttChannel);
    expect(attached[1]).toBeInstanceOf(WebSocketChannel);
    expect(channel).toBe(attached[1]);
    channel.close();
  });
});
