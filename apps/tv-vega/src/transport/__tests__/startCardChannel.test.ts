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

  it('keeps what the server says for the home screen: her light, and who looked in', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.pushControl({ t: 'home', home: { light: 'on' } });
    channel.pushControl({ t: 'home', home: { lookedIn: { name: 'Sarah', at: 7, line: 'Sarah looked in this morning.' } } });

    expect(store.readHome()).toEqual({ light: 'on', lookedIn: { name: 'Sarah', at: 7, line: 'Sarah looked in this morning.' } });
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

describe('startCardChannel — when her language changes (packages/contracts language.ts)', () => {
  /** A channel that can ask again for its cards, as the two real ones can. */
  class AskingChannel extends FakeChannel {
    asked = 0;
    failAsking = false;
    async reconcile(): Promise<void> {
      this.asked += 1;
      if (this.failAsking) throw new Error('not_connected');
    }
  }

  const note = (transcript: string, shownCount = 0): QueuedCard => ({
    id: 'note-1',
    urgency: 'DEFERRED',
    card: { type: 'MESSAGE', id: 'note-1', householdId: 'h1', correlationId: 'c', createdAt: 0, actions: [], fromName: 'Sarah', transcript, suggestedReplies: [] },
    queuedAt: 100,
    shownCount,
  });

  it('asks the server for its cards again, once: the ones it holds are in the language she had', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new AskingChannel();
    const running = startCardChannel(store, channel);

    // On connecting: the whole of the home, in English. Learning it is not a change.
    channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    expect(channel.asked).toBe(0);

    // She has said yes to Spanish.
    channel.pushControl({ t: 'home', home: { light: 'on', language: 'es' }, whole: true });
    expect(store.language()).toBe('es');
    expect(channel.asked).toBe(1);

    // The reconcile is answered with the whole of the home again, and other parts of it change: nothing more is asked.
    channel.pushControl({ t: 'home', home: { light: 'on', language: 'es' }, whole: true });
    channel.pushControl({ t: 'home', home: { light: 'out' } });
    expect(channel.asked).toBe(1);

    // And back to English, later: once more.
    channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    expect(store.language()).toBe('en');
    expect(channel.asked).toBe(2);

    running.stop();
  });

  it('does not ask when the television is only learning its home’s language: it has just connected, and is being sent its cards in it', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new AskingChannel();
    const running = startCardChannel(store, channel);

    channel.pushControl({ t: 'home', home: { language: 'es' }, whole: true });

    expect(store.language()).toBe('es');
    expect(channel.asked).toBe(0);
    running.stop();
  });

  it('puts each card sent again in the place of the one it held, and keeps what it had counted', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new AskingChannel();
    const running = startCardChannel(store, channel);
    channel.pushControl({ t: 'home', home: {}, whole: true });
    channel.pushCard(note('See you on Sunday.'));
    await settle();
    await store.countShowing('note-1');

    channel.pushControl({ t: 'home', home: { language: 'es' }, whole: true });
    // The server's answer: the same card, in Spanish, with a count that had not caught up.
    channel.pushCard(note('Nos vemos el domingo.', 0));
    await settle();

    const all = await store.readAll();
    expect(all).toHaveLength(1);
    expect((all[0]!.card as { transcript?: string }).transcript).toBe('Nos vemos el domingo.');
    expect(all[0]!.shownCount).toBe(1);
    running.stop();
  });

  it('carries on when the request cannot be sent, and with a channel that cannot ask at all', async () => {
    const store = new QueueStore(brokenFs());
    const failing = new AskingChannel();
    failing.failAsking = true;
    const running = startCardChannel(store, failing);
    failing.pushControl({ t: 'home', home: {}, whole: true });
    failing.pushControl({ t: 'home', home: { language: 'es' }, whole: true });
    await settle();
    expect(failing.asked).toBe(1);
    expect(store.language()).toBe('es');
    running.stop();

    const plain = new FakeChannel();
    const again = startCardChannel(store, plain);
    expect(() => plain.pushControl({ t: 'home', home: {}, whole: true })).not.toThrow();
    expect(store.language()).toBe('en');
    again.stop();
  });

  it('is not the card service’s to ask: behind another app it shows nothing, and is told nothing of the home', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new AskingChannel();
    const running = startBackgroundChannel(store, channel, () => undefined);

    channel.pushControl({ t: 'home', home: {}, whole: true });
    channel.pushControl({ t: 'home', home: { language: 'es' }, whole: true });

    expect(channel.asked).toBe(0);
    running.stop();
  });

  it('drops a card of a kind this build does not know as it arrives: nothing is held, and nothing is said of it', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new AskingChannel();
    const running = startCardChannel(store, channel);

    channel.pushCard({ ...note('x'), id: 'new-1', card: { ...note('x').card, id: 'new-1', type: 'SOMETHING_NEW' } } as unknown as QueuedCard);
    await settle();

    expect(await store.readAll()).toEqual([]);
    expect(channel.sent).toEqual([]);
    running.stop();
  });
});

describe('startCardChannel — her mantelpiece (packages/contracts mantel.ts)', () => {
  const item = (photoId: string, over: Record<string, unknown> = {}) => ({ photoId, fromName: 'Sarah', keptAt: 5, url: `https://pictures.example/${photoId}.jpg`, ...over });

  it('keeps the answer to its asking, with the moment it came', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);
    const before = Date.now();

    channel.pushControl({ t: 'mantel', items: [item('p1'), item('p2')] });

    const mantel = store.readMantel()!;
    expect(mantel.items.map((i) => i.photoId)).toEqual(['p1', 'p2']);
    expect(mantel.receivedAt).toBeGreaterThanOrEqual(before);
    running.stop();
  });

  it('keeps only what is well formed: an address that is not https is not a picture', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    channel.pushControl({ t: 'mantel', items: [item('p1', { url: 'http://pictures.example/p1.jpg' }), item('p2'), null, { photoId: 'p3' }] } as unknown as ControlMessage);
    expect(store.readMantel()!.items.map((i) => i.photoId)).toEqual(['p2']);

    channel.pushControl({ t: 'mantel', items: 'none' } as unknown as ControlMessage);
    expect(store.readMantel()!.items).toEqual([]);
    running.stop();
  });

  it('sends her asking, and her taking one down, like any other event', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    await store.enqueueOutbound({ t: 'mantel', at: 1 });
    await store.enqueueOutbound({ t: 'mantel_take_down', photoId: 'p1', at: 2 });
    await vi.advanceTimersByTimeAsync(1_100);

    expect(channel.sent).toEqual([{ t: 'mantel', at: 1 }, { t: 'mantel_take_down', photoId: 'p1', at: 2 }]);
    running.stop();
  });

  it('is not the card service’s to keep: behind another app nothing is shown, and nothing was asked', async () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startBackgroundChannel(store, channel, () => undefined);

    channel.pushControl({ t: 'mantel', items: [item('p1')] });

    expect(store.readMantel()).toBeUndefined();
    running.stop();
  });
});

describe('asking for the cards again, from the app — a picture whose address has run out (packages/contracts mantel.ts)', () => {
  class AskingChannel extends FakeChannel {
    asked = 0;
    failAsking = false;
    async reconcile(): Promise<void> {
      this.asked += 1;
      if (this.failAsking) throw new Error('not_connected');
    }
  }

  it('asks the channel, once for each asking', () => {
    const channel = new AskingChannel();
    const running = startCardChannel(new QueueStore(brokenFs()), channel);

    running.reconcile();
    expect(channel.asked).toBe(1);
    running.reconcile();
    expect(channel.asked).toBe(2);
    running.stop();
  });

  it('carries on when it cannot be sent, with a channel that cannot ask, and after it has stopped', async () => {
    const failing = new AskingChannel();
    failing.failAsking = true;
    const running = startCardChannel(new QueueStore(brokenFs()), failing);
    expect(() => running.reconcile()).not.toThrow();
    await settle();
    running.stop();
    running.reconcile();
    expect(failing.asked).toBe(1);

    const plain = startCardChannel(new QueueStore(brokenFs()), new FakeChannel());
    expect(() => plain.reconcile()).not.toThrow();
    plain.stop();
  });

  it('is asked through the channel the app holds — and does nothing before it is connected, or once it is let go', async () => {
    const channel = new AskingChannel();
    let connect: (c: AskingChannel) => void = () => undefined;
    const held = holdCardChannel(new QueueStore(brokenFs()), TOKEN, () => new Promise((resolve) => (connect = resolve)), { websocketUrl: 'wss://x' });

    held.reconcile();
    expect(channel.asked).toBe(0);

    connect(channel);
    await settle();
    held.reconcile();
    expect(channel.asked).toBe(1);

    held.stop();
    held.reconcile();
    expect(channel.asked).toBe(1);
  });

  it('is never the card service’s to ask: it shows no card, so it has no picture to miss', () => {
    const channel = new AskingChannel();
    const running = startBackgroundChannel(new QueueStore(brokenFs()), channel, () => undefined);

    running.reconcile();

    expect(channel.asked).toBe(0);
    running.stop();
  });
});

describe('startCardChannel — read to me (packages/contracts speech.ts)', () => {
  const URL = 'https://speech.example/tts/h1/abc.mp3';

  it('sends her asking like any other event, once', async () => {
    vi.useFakeTimers();
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);

    await store.enqueueOutbound({ t: 'read', cardId: 'note-1', at: 1 });
    await vi.advanceTimersByTimeAsync(2_100);

    expect(channel.sent).toEqual([{ t: 'read', cardId: 'note-1', at: 1 }]);
    running.stop();
  });

  it('hands the answer to the app as it arrives, with the card it is for', () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);
    const heard: unknown[] = [];
    store.onSpeech((cardId, url) => heard.push([cardId, url]));

    channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
    channel.pushControl({ t: 'speech', cardId: 'note-2' });

    expect(heard).toEqual([['note-1', URL], ['note-2', undefined]]);
    running.stop();
  });

  it('takes no notice of an answer that names no card', () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startCardChannel(store, channel);
    const heard: unknown[] = [];
    store.onSpeech((cardId) => heard.push(cardId));

    channel.pushControl({ t: 'speech', url: URL } as unknown as ControlMessage);
    channel.pushControl({ t: 'speech', cardId: 7, url: URL } as unknown as ControlMessage);

    expect(heard).toEqual([]);
    running.stop();
  });

  it('is not the card service’s to hear: behind another app nothing is read aloud', () => {
    const store = new QueueStore(brokenFs());
    const channel = new FakeChannel();
    const running = startBackgroundChannel(store, channel, () => undefined);
    const heard: unknown[] = [];
    store.onSpeech((cardId) => heard.push(cardId));

    channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });

    expect(heard).toEqual([]);
    running.stop();
  });
});
