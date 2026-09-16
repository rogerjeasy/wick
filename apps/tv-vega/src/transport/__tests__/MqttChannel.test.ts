import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { MqttChannel, type MqttConnector } from '../MqttChannel.js';

const TOKEN: DeviceToken = {
  jwt: 'jwt.token.here',
  deviceId: 'dev-1',
  householdId: 'hh-1',
  expiresAt: Date.now() + 1000,
};

class FakeMqttClient extends EventEmitter {
  published: Array<{ topic: string; payload: string }> = [];
  subscribed: string[] = [];
  ended = false;

  subscribe(topics: string[], _opts: unknown, cb: (err?: Error) => void): void {
    this.subscribed.push(...topics);
    cb();
  }

  publish(topic: string, payload: string, _opts: unknown, cb: (err?: Error) => void): void {
    this.published.push({ topic, payload });
    cb();
  }

  end(_force?: boolean): void {
    this.ended = true;
  }
}

function fakeConnector(client: FakeMqttClient): MqttConnector {
  return () => client as unknown as ReturnType<MqttConnector>;
}

describe('MqttChannel', () => {
  it('connects, subscribes to card and control topics, and resolves', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));

    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    expect(channel.state).toBe('open');
    expect(client.subscribed).toEqual(['wick/device/dev-1/cards', 'wick/device/dev-1/control']);
  });

  it('delivers a card message to onCard handlers', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));
    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    const card: QueuedCard = {
      id: 'c1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'c1', householdId: 'hh-1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
      queuedAt: 0,
      shownCount: 0,
    };
    const received: QueuedCard[] = [];
    channel.onCard((c) => received.push(c));
    client.emit('message', 'wick/device/dev-1/cards', Buffer.from(JSON.stringify(card)));

    expect(received).toEqual([card]);
  });

  it('publishes a DeviceEvent to the events topic', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));
    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    await channel.send({ t: 'card_shown', cardId: 'c1', at: 1 });

    expect(client.published).toEqual([
      { topic: 'wick/device/dev-1/events', payload: JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 }) },
    ]);
  });

  it('rejects if the connector never emits connect within the timeout', async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const channel = new MqttChannel(
      { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 50 },
      fakeConnector(client),
    );

    const connecting = channel.connect(TOKEN);
    const assertion = expect(connecting).rejects.toThrow('mqtt_connect_timeout');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(client.ended).toBe(true);
    vi.useRealTimers();
  });
});
