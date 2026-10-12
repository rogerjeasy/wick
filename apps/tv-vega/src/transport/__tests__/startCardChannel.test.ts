import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelState, ControlMessage, DeviceChannel, DeviceEvent, DeviceToken, QueuedCard } from '@wick/contracts';
import { holdCardChannel, startBackgroundChannel, startCardChannel } from '../startCardChannel.js';
import { QueueStore, type FileSystemLike } from '../../headless/QueueStore.js';

/** The VVD's real disk (FL-013): every call rejects. The runner must not depend on it. */
function brokenFs(): FileSystemLike {
  const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
  return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
}

class FakeChannel implements DeviceChannel {
  state: ChannelState = 'open';
  readonly sent: DeviceEvent[] = [];
  failSends = false;
  closed = false;
  readonly #cards = new Set<(c: QueuedCard) => void>();
  readonly #controls = new Set<(m: ControlMessage) => void>();

  async connect(): Promise<void> {}
  close(): void {
    this.closed = true;
    this.state = 'closed';
  }
  onCard(h: (c: QueuedCard) => void) {
    this.#cards.add(h);
    return () => this.#cards.delete(h);
  }
  onControl(h: (m: ControlMessage) => void) {
    this.#controls.add(h);
    return () => this.#controls.delete(h);
  }
  async send(e: DeviceEvent): Promise<void> {
    if (this.failSends) throw new Error('not_connected');
    this.sent.push(e);
  }
  pushCard(c: QueuedCard): void {
    for (const h of this.#cards) h(c);
  }
  pushControl(m: ControlMessage): void {
    for (const h of this.#controls) h(m);
  }
  get listenerCount(): number {
    return this.#cards.size + this.#controls.size;
  }
}

const doorCard = (id: string): QueuedCard => ({
  id,
  urgency: 'DOOR',
  card: { type: 'DOOR', id, householdId: 'h1', correlationId: 'c', createdAt: 0, actions: [], line: 'Someone is at the door.' },
  queuedAt: 0,
  shownCount: 0,
});

/** The handlers fire-and-forget into the store; a macrotask boundary drains them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('startCardChannel — the card channel, runnable in whichever process renders (FL-014)', () => {
  it('puts an inbound card in the same store the UI reads, with no disk involved', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.pushCard(doorCard('c1'));
    await settle();

    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    // Arriving is not being shown: the app says `card_shown` when the card is on screen.
    expect(channel.sent).toEqual([]);
    running.stop();
  });

  it('applies a Phase 2 patch and a revoke to the queued card', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.pushCard(doorCard('c1'));
    channel.pushCard(doorCard('c2'));
    await settle();
    channel.pushControl({ t: 'patch', patch: { cardId: 'c1', description: 'A courier in a blue jacket.' } });
    channel.pushControl({ t: 'revoke', cardId: 'c2' });
    await settle();

    const all = await store.readAll();
    expect(all.map((c) => c.id)).toEqual(['c1']);
    expect((all[0]!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
    running.stop();
  });

  it('flushes outbound events the UI queued, on its poll interval', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 1 });
    await vi.advanceTimersByTimeAsync(1100);

    expect(channel.sent).toEqual([{ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 1 }]);
    running.stop();
  });

  it('keeps an event it could not send, and delivers it on a later tick', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.failSends = true;
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(channel.sent).toEqual([]);

    channel.failSends = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(channel.sent).toEqual([{ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 1 }]);
    running.stop();
  });

  it('holds events while the channel is reconnecting instead of dropping them', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.state = 'backoff';
    await store.enqueueOutbound({ t: 'break_state', state: 'AT_BREAK', at: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(channel.sent).toEqual([]);

    channel.state = 'open';
    await vi.advanceTimersByTimeAsync(1100);
    expect(channel.sent).toEqual([{ t: 'break_state', state: 'AT_BREAK', at: 1 }]);
    running.stop();
  });

  it('stop() closes the channel, detaches every handler and stops flushing', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    running.stop();
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'dismiss', at: 1 });
    await vi.advanceTimersByTimeAsync(5000);

    expect(channel.closed).toBe(true);
    expect(channel.listenerCount).toBe(0);
    expect(channel.sent).toEqual([]);
  });
});

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'wick-tv', householdId: 'h1', expiresAt: Date.now() + 100_000 };

describe('holdCardChannel — what App.tsx runs once the device is ready', () => {
  it('connects with the token it was given and delivers cards into the store', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const tokens: DeviceToken[] = [];
    const held = holdCardChannel(store, TOKEN, async (_config, token) => {
      tokens.push(token);
      return channel;
    }, { websocketUrl: 'wss://ws.example' });
    await settle();

    channel.pushCard(doorCard('c1'));
    await settle();

    expect(tokens).toEqual([TOKEN]);
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    held.stop();
    expect(channel.closed).toBe(true);
  });

  it('reports the last-seen card id to reconcile, from the same store', async () => {
    const store = new QueueStore(brokenFs());
    await store.upsert(doorCard('c7'));
    let reported: string | undefined;
    const held = holdCardChannel(store, TOKEN, async (config) => {
      reported = await config.websocket.getLastSeenCardId?.();
      return new FakeChannel();
    }, { websocketUrl: 'wss://ws.example' });
    await settle();

    expect(reported).toBe('c7');
    held.stop();
  });

  it('reports the cards it holds to reconcile, from the same store, on both channels', async () => {
    const store = new QueueStore(brokenFs());
    await store.upsert(doorCard('c7'));
    await store.upsert(doorCard('c8'));
    let overWebSocket: readonly string[] | undefined;
    let overMqtt: readonly string[] | undefined;
    const held = holdCardChannel(store, TOKEN, async (config) => {
      overWebSocket = await config.websocket.getHeldCardIds?.();
      overMqtt = await config.mqtt?.getHeldCardIds?.();
      return new FakeChannel();
    }, { websocketUrl: 'wss://ws.example', mqttWssUrl: 'wss://iot.example/mqtt' });
    await settle();

    expect(overWebSocket).toEqual(['c7', 'c8']);
    expect(overMqtt).toEqual(['c7', 'c8']);
    held.stop();
  });

  it('retries a failed first connect, backing off, until it succeeds', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    let attempts = 0;
    const held = holdCardChannel(store, TOKEN, async () => {
      attempts++;
      if (attempts < 3) throw new Error('websocket_closed_before_open');
      return channel;
    }, { websocketUrl: 'wss://ws.example' });

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toBe(3);

    channel.pushCard(doorCard('c1'));
    await vi.advanceTimersByTimeAsync(0);
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    held.stop();
  });

  it('stop() while still retrying ends the retries', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const held = holdCardChannel(new QueueStore(brokenFs()), TOKEN, async () => {
      attempts++;
      throw new Error('websocket_closed_before_open');
    }, { websocketUrl: 'wss://ws.example' });

    await vi.advanceTimersByTimeAsync(0);
    held.stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(attempts).toBe(1);
  });

  it('stop() before a pending connect resolves closes that channel instead of running it', async () => {
    const channel = new FakeChannel();
    let resolveConnect: (c: DeviceChannel) => void = () => undefined;
    const held = holdCardChannel(new QueueStore(brokenFs()), TOKEN, () => new Promise((r) => (resolveConnect = r)), {
      websocketUrl: 'wss://ws.example',
    });

    held.stop();
    resolveConnect(channel);
    await settle();

    expect(channel.closed).toBe(true);
    expect(channel.listenerCount).toBe(0);
  });
});

describe('startBackgroundChannel', () => {
  it('announces a card that arrives, and does not claim it was shown', async () => {
    const channel = new FakeChannel();
    const announced: string[] = [];
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, (card) => announced.push(card.id));

    channel.pushCard(doorCard('door-1'));
    await settle();

    expect(announced).toEqual(['door-1']);
    expect(channel.sent).toEqual([]);
    running.stop();
  });

  it('announces the card again, once, when what was seen at the door arrives', async () => {
    const channel = new FakeChannel();
    const announced: { id: string; description?: string; imageRef?: string }[] = [];
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, (card) => {
      if (card.card.type === 'DOOR') announced.push({ id: card.id, ...(card.card.description ? { description: card.card.description } : {}), ...(card.card.imageRef ? { imageRef: card.card.imageRef } : {}) });
    });

    channel.pushCard(doorCard('door-1'));
    channel.pushControl({ t: 'patch', patch: { cardId: 'door-1', imageRef: 'https://cdn.example/door.jpg' } });
    channel.pushControl({ t: 'patch', patch: { cardId: 'door-1', description: 'A man holding a parcel.' } });
    // Later patches — the chime rang, the buttons changed — are not news about who is there.
    channel.pushControl({ t: 'patch', patch: { cardId: 'door-1', notice: 'The hallway chime rang.' } });
    channel.pushControl({ t: 'patch', patch: { cardId: 'door-1', description: 'A man holding a parcel.' } });
    await settle();

    expect(announced).toEqual([
      { id: 'door-1' },
      { id: 'door-1', description: 'A man holding a parcel.', imageRef: 'https://cdn.example/door.jpg' },
    ]);
    running.stop();
  });

  it('does not announce the picture on its own: a second toast is for when there is something to say', async () => {
    const channel = new FakeChannel();
    const announced: string[] = [];
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, (card) => announced.push(card.id));

    channel.pushCard(doorCard('door-1'));
    channel.pushControl({ t: 'patch', patch: { cardId: 'door-1', imageRef: 'https://cdn.example/door.jpg' } });
    await settle();

    expect(announced).toEqual(['door-1']);
    running.stop();
  });

  it('says nothing about a description for a card it never had — the app was on screen when that one came', async () => {
    const channel = new FakeChannel();
    const announced: string[] = [];
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, (card) => announced.push(card.id));

    channel.pushControl({ t: 'patch', patch: { cardId: 'door-9', description: 'A man holding a parcel.' } });
    await settle();

    expect(announced).toEqual([]);
    running.stop();
  });

  it("leaves the app's outbox alone", async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    const store = new QueueStore(brokenFs());
    const drain = vi.spyOn(store, 'drainOutbound');
    const running = startBackgroundChannel(store, channel, () => undefined);

    await vi.advanceTimersByTimeAsync(5000);

    expect(drain).not.toHaveBeenCalled();
    running.stop();
  });

  it('stops listening and closes the connection when stopped', () => {
    const channel = new FakeChannel();
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, () => undefined);

    running.stop();

    expect(channel.listenerCount).toBe(0);
    expect(channel.closed).toBe(true);
  });
});

describe('holdCardChannel — for the card service', () => {
  const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 };

  it('asks for the background connection, and announces what arrives on it', async () => {
    const channel = new FakeChannel();
    const asked: unknown[] = [];
    const announced: string[] = [];
    const held = holdCardChannel(
      new QueueStore(brokenFs()),
      TOKEN,
      async (config) => {
        asked.push(config);
        return channel;
      },
      { websocketUrl: 'wss://ws.example', mqttWssUrl: 'wss://mqtt.example' },
      (card) => announced.push(card.id),
    );
    await settle();

    channel.pushCard(doorCard('door-1'));
    await settle();

    expect(asked).toEqual([{ websocket: { url: 'wss://ws.example', role: 'background' } }]);
    expect(announced).toEqual(['door-1']);
    expect(channel.sent).toEqual([]);
    held.stop();
  });
});
