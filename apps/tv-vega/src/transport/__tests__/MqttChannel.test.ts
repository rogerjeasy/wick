import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { MqttChannel, mqttUrl, type MqttConnector } from '../MqttChannel.js';

const TOKEN: DeviceToken = {
  jwt: 'jwt.token.here',
  deviceId: 'dev-1',
  householdId: 'hh-1',
  expiresAt: Date.now() + 1000,
};

const WSS = 'wss://iot.example/mqtt?x-amz-customauthorizer-name=wick-device';
const EVENTS = 'wick/device/dev-1/events';

class FakeMqttClient extends EventEmitter {
  published: Array<{ topic: string; payload: string }> = [];
  subscribed: string[] = [];
  ended = false;
  subscribeError: Error | undefined;

  subscribe(topics: string[], _opts: unknown, cb: (err?: Error) => void): void {
    this.subscribed.push(...topics);
    cb(this.subscribeError);
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

/** A broker that hands out a new client per connection, and remembers how each was asked for. */
function broker() {
  const clients: FakeMqttClient[] = [];
  const asked: Array<{ url: string; options: Record<string, unknown> }> = [];
  const connect: MqttConnector = (url, options) => {
    asked.push({ url, options });
    const client = new FakeMqttClient();
    clients.push(client);
    return client as unknown as ReturnType<MqttConnector>;
  };
  return { clients, asked, connect };
}

/** Everything a client published that was not the reconcile request. */
const sent = (client: FakeMqttClient) => client.published.filter((p) => !p.payload.includes('"reconcile"'));

async function opened(channel: MqttChannel, client: FakeMqttClient): Promise<void> {
  const connecting = channel.connect(TOKEN);
  client.emit('connect');
  await connecting;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mqttUrl', () => {
  it('adds the token to an address that already names the authorizer', () => {
    expect(mqttUrl(WSS, 'a.b.c')).toBe(`${WSS}&token=a.b.c`);
  });

  it('adds it to a bare address too, and encodes it', () => {
    expect(mqttUrl('wss://iot.example/mqtt', 'a+b/c=')).toBe('wss://iot.example/mqtt?token=a%2Bb%2Fc%3D');
  });
});

describe('MqttChannel', () => {
  it('connects, subscribes to card and control topics, and resolves', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));

    await opened(channel, client);

    expect(channel.state).toBe('open');
    expect(client.subscribed).toEqual(['wick/device/dev-1/cards', 'wick/device/dev-1/control']);
  });

  it('carries the token in the address, never as a password — a WebSocket cannot send one IoT Core will read', async () => {
    const { clients, asked, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS }, connect);

    const connecting = channel.connect(TOKEN);
    clients[0]!.emit('connect');
    await connecting;

    expect(asked[0]!.url).toBe(`${WSS}&token=jwt.token.here`);
    expect(asked[0]!.options).not.toHaveProperty('password');
    expect(asked[0]!.options).not.toHaveProperty('username');
  });

  it('connects under the television\'s own id, the only name its policy allows', async () => {
    const { clients, asked, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS }, connect);

    const connecting = channel.connect(TOKEN);
    clients[0]!.emit('connect');
    await connecting;

    expect(asked[0]!.options).toMatchObject({ clientId: 'dev-1', clean: false, reconnectPeriod: 0 });
  });

  it('asks for the cards it is owed as soon as it is connected', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS, getLastSeenCardId: async () => 'card-7' }, fakeConnector(client));

    await opened(channel, client);

    expect(client.published).toEqual([{ topic: EVENTS, payload: JSON.stringify({ t: 'reconcile', sinceCardId: 'card-7' }) }]);
  });

  it('delivers a card message to onCard handlers', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));
    await opened(channel, client);

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

  it('delivers a control message to onControl handlers', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));
    await opened(channel, client);

    const control = { t: 'revoke' as const, cardId: 'c1' };
    const received: unknown[] = [];
    channel.onControl((m) => received.push(m));
    client.emit('message', 'wick/device/dev-1/control', Buffer.from(JSON.stringify(control)));

    expect(received).toEqual([control]);
  });

  it('publishes a DeviceEvent to the events topic', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));
    await opened(channel, client);

    await channel.send({ t: 'card_shown', cardId: 'c1', at: 1 });

    expect(sent(client)).toEqual([{ topic: EVENTS, payload: JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 }) }]);
  });

  it('rejects if the connector never emits connect within the timeout', async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS, connectTimeoutMs: 50 }, fakeConnector(client));

    const connecting = channel.connect(TOKEN);
    const assertion = expect(connecting).rejects.toThrow('mqtt_connect_timeout');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(client.ended).toBe(true);
  });

  it('rejects if subscribe fails in the connect callback', async () => {
    const client = new FakeMqttClient();
    client.subscribeError = new Error('subscribe_failed');
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));

    const connecting = channel.connect(TOKEN);
    client.emit('connect');

    await expect(connecting).rejects.toThrow('subscribe_failed');
  });

  it('rejects if client emits error before connect', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));

    const connecting = channel.connect(TOKEN);
    client.emit('error', new Error('connection_refused'));

    await expect(connecting).rejects.toThrow('connection_refused');
  });

  it('does not keep trying after a first connection fails — the WebSocket takes over, and must keep the television', async () => {
    vi.useFakeTimers();
    const { clients, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS }, connect);

    const connecting = channel.connect(TOKEN);
    const assertion = expect(connecting).rejects.toThrow('connection_refused');
    clients[0]!.emit('error', new Error('connection_refused'));
    await assertion;
    await vi.advanceTimersByTimeAsync(120_000);

    expect(clients).toHaveLength(1);
    expect(channel.state).toBe('closed');
  });

  it('reconnects by itself when an open connection drops, and asks again for what it is owed', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { clients, asked, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS, getLastSeenCardId: () => 'card-7' }, connect);
    const connecting = channel.connect(TOKEN);
    clients[0]!.emit('connect');
    await connecting;

    clients[0]!.emit('close');
    expect(channel.state).toBe('backoff');
    await vi.advanceTimersByTimeAsync(500);
    expect(clients).toHaveLength(2);
    clients[1]!.emit('connect');
    await vi.advanceTimersByTimeAsync(0);

    expect(channel.state).toBe('open');
    expect(asked[1]!.url).toBe(asked[0]!.url);
    expect(clients[1]!.published).toEqual([{ topic: EVENTS, payload: JSON.stringify({ t: 'reconcile', sinceCardId: 'card-7' }) }]);
  });

  it('keeps trying, less often each time, while the broker stays unreachable', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const { clients, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS, connectTimeoutMs: 10 }, connect);
    const connecting = channel.connect(TOKEN);
    clients[0]!.emit('connect');
    await connecting;

    clients[0]!.emit('close');
    await vi.advanceTimersByTimeAsync(1_000); // first retry after 1 s
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10); // …which times out
    await vi.advanceTimersByTimeAsync(1_999);
    expect(clients).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); // second retry after 2 s
    expect(clients).toHaveLength(3);
    expect(channel.state).toBe('connecting');
  });

  it('stops for good when closed, whatever was pending', async () => {
    vi.useFakeTimers();
    const { clients, connect } = broker();
    const channel = new MqttChannel({ wssUrl: WSS }, connect);
    const connecting = channel.connect(TOKEN);
    clients[0]!.emit('connect');
    await connecting;
    clients[0]!.emit('close');

    channel.close();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(clients).toHaveLength(1);
    expect(channel.state).toBe('closed');
  });

  it('refuses to send while it is not connected, so the event is kept for later', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: WSS }, fakeConnector(client));

    await expect(channel.send({ t: 'card_shown', cardId: 'c1', at: 1 })).rejects.toThrow('not_connected');

    await opened(channel, client);
    client.emit('close');

    await expect(channel.send({ t: 'card_shown', cardId: 'c1', at: 1 })).rejects.toThrow('not_connected');
  });
});
