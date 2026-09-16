import { describe, expect, it, vi } from 'vitest';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { WebSocketChannel, type WebSocketFactory } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = {
  jwt: 'jwt.token.here',
  deviceId: 'dev-1',
  householdId: 'hh-1',
  expiresAt: Date.now() + 1000,
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

function fakeFactory(): WebSocketFactory {
  return (url: string) => new FakeSocket(url) as unknown as WebSocket;
}

describe('WebSocketChannel', () => {
  it('connects, sends reconcile on open, and resolves', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel(
      { url: 'wss://api.example/prod', getLastSeenCardId: () => 'c9' },
      fakeFactory(),
    );

    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('wss://api.example/prod?token=jwt.token.here');
    socket.onopen?.();
    await connecting;

    expect(channel.state).toBe('open');
    expect(socket.sent).toEqual([JSON.stringify({ t: 'reconcile', sinceCardId: 'c9' })]);
  });

  it('delivers a card wire message to onCard handlers', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
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
    socket.onmessage?.({ data: JSON.stringify({ kind: 'card', card }) });

    expect(received).toEqual([card]);
  });

  it('sends a DeviceEvent as raw JSON', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    await connecting;

    await channel.send({ t: 'card_shown', cardId: 'c1', at: 1 });

    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 }));
  });

  it('reconnects with full-jitter backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    FakeSocket.instances[0]!.onopen?.();
    await connecting;

    FakeSocket.instances[0]!.onclose?.();
    expect(channel.state).toBe('backoff');

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances.length).toBe(2);

    vi.useRealTimers();
  });

  it('does not reconnect after an intentional close()', async () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    FakeSocket.instances[0]!.onopen?.();
    await connecting;

    channel.close();
    expect(channel.state).toBe('closed');

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances.length).toBe(1);

    vi.useRealTimers();
  });
});
