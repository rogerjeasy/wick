/**
 * A connection that dies without saying so, frames that are not what they
 * should be, and an hour without a network: what WebSocketChannel does
 * about each. The door card is the one thing that must not silently stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage, DeviceToken, QueuedCard } from '@wick/contracts';
import { WebSocketChannel, type WebSocketFactory } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = { jwt: 'jwt', deviceId: 'dev-1', householdId: 'hh-1', expiresAt: Date.now() + 1000 };

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data?: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sendThrows = false;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    if (this.sendThrows) throw new Error('socket_gone');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}
const factory: WebSocketFactory = (url) => new FakeSocket(url) as unknown as WebSocket;
const card: QueuedCard = {
  id: 'c1',
  urgency: 'DOOR',
  card: { type: 'DOOR', id: 'c1', householdId: 'hh-1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
  queuedAt: 0,
  shownCount: 0,
};

async function open(config: ConstructorParameters<typeof WebSocketChannel>[0] = { url: 'wss://api.example/prod' }) {
  const channel = new WebSocketChannel(config, factory);
  const connecting = channel.connect(TOKEN);
  FakeSocket.instances.at(-1)!.onopen?.();
  await connecting;
  return channel;
}

describe('WebSocketChannel liveness', () => {
  let rejections: unknown[];
  const onRejection = (reason: unknown): void => void rejections.push(reason);
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    rejections = [];
    process.on('unhandledRejection', onRejection);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('the heartbeat', () => {
    it('asks the edge ping on a timer while open', async () => {
      await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      const socket = FakeSocket.instances[0]!;
      await vi.advanceTimersByTimeAsync(1000);
      expect(socket.sent.filter((m) => m === JSON.stringify({ t: 'ping' }))).toHaveLength(1);
    });

    it('lets the connection go and makes another when nothing comes back', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      await vi.advanceTimersByTimeAsync(1000 + 500);
      expect(FakeSocket.instances[0]!.closed).toBe(true);
      expect(channel.state).toBe('backoff');
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it('says it is not connected while it is waiting to reconnect, so a send is refused rather than lost', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      await vi.advanceTimersByTimeAsync(1500);
      await expect(channel.send({ t: 'card_shown', cardId: 'c1', at: 1 })).rejects.toThrow('not_connected');
    });

    it('is satisfied by a pong, and keeps the connection', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      const socket = FakeSocket.instances[0]!;
      // Five beats, each answered a moment after it is asked.
      for (let beat = 0; beat < 5; beat += 1) {
        await vi.advanceTimersByTimeAsync(1000);
        socket.onmessage?.({ data: JSON.stringify({ kind: 'control', control: { t: 'pong' } }) });
      }
      expect(channel.state).toBe('open');
      expect(socket.closed).toBe(false);
      expect(socket.sent.filter((m) => m.includes('ping'))).toHaveLength(5);
    });

    it('is satisfied by any frame, a card included', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      const socket = FakeSocket.instances[0]!;
      await vi.advanceTimersByTimeAsync(1000);
      socket.onmessage?.({ data: JSON.stringify({ kind: 'card', card }) });
      await vi.advanceTimersByTimeAsync(600);
      expect(channel.state).toBe('open');
    });

    it('does not hand a pong to anyone who listens for control messages', async () => {
      const channel = await open();
      const heard: ControlMessage[] = [];
      channel.onControl((m) => heard.push(m));
      FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ kind: 'control', control: { t: 'pong' } }) });
      FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ kind: 'control', control: { t: 'revoke', cardId: 'c1' } }) });
      expect(heard).toEqual([{ t: 'revoke', cardId: 'c1' }]);
    });

    it('gives up at once when the socket cannot even be written to', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      FakeSocket.instances[0]!.sendThrows = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(channel.state).toBe('backoff');
    });

    it('stops asking after an intentional close', async () => {
      const channel = await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      const socket = FakeSocket.instances[0]!;
      channel.close();
      const before = socket.sent.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(socket.sent.length).toBe(before);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('asks again after reconnecting', async () => {
      await open({ url: 'wss://x', heartbeatMs: 1000, pongWaitMs: 500 });
      await vi.advanceTimersByTimeAsync(1500); // dead
      await vi.advanceTimersByTimeAsync(1000); // reconnect attempt
      FakeSocket.instances[1]!.onopen?.();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeSocket.instances[1]!.sent.filter((m) => m.includes('ping'))).toHaveLength(1);
    });
  });

  describe('frames that are not what they should be', () => {
    it.each([
      ['not JSON', '{"kind":'],
      ['JSON null', 'null'],
      ['an array', '[1,2]'],
      ['no kind', JSON.stringify({ card })],
      ['a card without a card', JSON.stringify({ kind: 'card' })],
      ['a card with no id', JSON.stringify({ kind: 'card', card: { card: { type: 'DOOR' } } })],
      ['a control message without t', JSON.stringify({ kind: 'control', control: {} })],
    ])('drops %s and goes on', async (_name, data) => {
      const channel = await open();
      const heard: unknown[] = [];
      channel.onCard((c) => heard.push(c));
      channel.onControl((m) => heard.push(m));
      expect(() => FakeSocket.instances[0]!.onmessage?.({ data })).not.toThrow();
      expect(heard).toEqual([]);
      FakeSocket.instances[0]!.onmessage?.({ data: JSON.stringify({ kind: 'card', card }) });
      expect(heard).toEqual([card]);
    });

    it('reads a frame with no data as nothing', async () => {
      await open();
      expect(() => FakeSocket.instances[0]!.onmessage?.({})).not.toThrow();
    });
  });

  describe('an hour without a network', () => {
    it('makes no unhandled rejection when every reconnect fails before it opens', async () => {
      const channel = await open();
      FakeSocket.instances[0]!.onclose?.();
      for (let i = 0; i < 120; i += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        FakeSocket.instances.at(-1)!.onclose?.(); // closes before it ever opened
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(rejections).toEqual([]);
      expect(channel.state).toBe('backoff');
      expect(FakeSocket.instances.length).toBeGreaterThan(50);
    });

    it('opens again when the network returns', async () => {
      const channel = await open();
      FakeSocket.instances[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(1000);
      FakeSocket.instances.at(-1)!.onclose?.();
      await vi.advanceTimersByTimeAsync(2000);
      FakeSocket.instances.at(-1)!.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(channel.state).toBe('open');
    });

    it('survives a socket that cannot be made at all', async () => {
      let failing = false;
      const flaky: WebSocketFactory = (url) => {
        if (failing) throw new Error('no_network_stack');
        return new FakeSocket(url) as unknown as WebSocket;
      };
      const channel = new WebSocketChannel({ url: 'wss://x' }, flaky);
      const connecting = channel.connect(TOKEN);
      FakeSocket.instances[0]!.onopen?.();
      await connecting;
      failing = true;
      FakeSocket.instances[0]!.onclose?.();
      await vi.advanceTimersByTimeAsync(40_000);
      failing = false;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(rejections).toEqual([]);
      expect(FakeSocket.instances.length).toBeGreaterThan(1);
    });
  });

  describe('opening', () => {
    it('still opens when asking for the cards it is owed throws', async () => {
      const channel = await open({
        url: 'wss://x',
        getLastSeenCardId: () => {
          throw new Error('disk_gone');
        },
      });
      expect(channel.state).toBe('open');
      expect(rejections).toEqual([]);
    });

    it('does not keep a replaced socket’s late close from starting a second connection', async () => {
      const channel = await open();
      const old = FakeSocket.instances[0]!;
      // connect() again: the old socket's own close arrives afterwards, as a real socket's does.
      old.close = () => {
        old.closed = true;
      };
      const second = channel.connect(TOKEN);
      FakeSocket.instances[1]!.onopen?.();
      await second;
      old.onclose?.();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(channel.state).toBe('open');
    });
  });
});
