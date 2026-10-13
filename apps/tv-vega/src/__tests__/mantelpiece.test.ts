/**
 * The mantelpiece (packages/contracts/src/mantel.ts), end to end on her
 * own television — the parts ResidentApp.tsx runs, in the order it runs
 * them, over a channel that is not a real one: a picture arrives and is
 * kept, her mantelpiece is found full, and her pictures fill a home screen
 * left untouched until a card or a key ends it.
 *
 * ResidentApp itself is a React component and is not rendered here (no
 * view in this app is); mantel/__tests__/screens.test.ts holds it to using
 * these same parts. No photograph is used: a picture is only an address,
 * and none is fetched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MANTEL_EACH_FOR_MS,
  MANTEL_FULL_NOTICE,
  MANTEL_IDLE_AFTER_MS,
  PHOTO_ACTIONS,
  buildReachAskCard,
  photoCardId,
  photoCardWords,
  type ChannelState,
  type ControlMessage,
  type DeviceChannel,
  type DeviceEvent,
  type MantelItem,
  type PhotoCard,
  type QueuedCard,
} from '@wick/contracts';
import { BreakController } from '../break/BreakController.js';
import { removesCard } from '../cards/cardActions.js';
import { QueueStore, type FileSystemLike } from '../headless/QueueStore.js';
import { ASK_SEND_WITHIN_MS, asking } from '../home/asked.js';
import { LIGHT_ANSWER_WAIT_MS } from '../home/light.js';
import { newestReachCard, reachOffersToPutAway } from '../home/reach.js';
import { waitingLine } from '../home/waiting.js';
import { IDLE_OFF, blocksHome, idleOnKey, lookAtIdle, type Idle } from '../mantel/idle.js';
import { MANTEL_FRESH_FOR_MS, offersMantel, overMantel, pictureRefresher } from '../mantel/mantel.js';
import { startCardChannel } from '../transport/startCardChannel.js';

function noDisk(): FileSystemLike {
  const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
  return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
}

class FakeChannel implements DeviceChannel {
  state: ChannelState = 'open';
  readonly sent: DeviceEvent[] = [];
  readonly #cards = new Set<(c: QueuedCard) => void>();
  readonly #controls = new Set<(m: ControlMessage) => void>();
  async connect(): Promise<void> {}
  close(): void {
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
    this.sent.push(e);
  }
  pushCard(c: QueuedCard): void {
    for (const h of this.#cards) h(c);
  }
  pushControl(m: ControlMessage): void {
    for (const h of this.#controls) h(m);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = 1_800_000_000_000;
/** Long enough on the home screen for a note to be let through (NaturalBreakEngine TV_SETTLED). */
const SETTLED = NOW + 60_000;

function photo(over: Partial<PhotoCard> = {}, shownCount = 0): QueuedCard {
  const id = photoCardId('p9');
  const card: PhotoCard = {
    householdId: 'hh-1', correlationId: 'c', createdAt: NOW, id, type: 'PHOTO', photoId: 'p9', fromName: 'Sarah',
    photoUrl: 'https://pictures.example/p9.jpg', ...photoCardWords('Sarah'), ...over,
  };
  return { id, urgency: 'DEFERRED', card, queuedAt: NOW, shownCount };
}
const door = (id: string, at: number): QueuedCard => ({
  id, urgency: 'DOOR', queuedAt: at, shownCount: 0,
  card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'c', createdAt: at, actions: [], line: 'Someone is at the front door.' },
});
const kept = (photoId: string, fromName = 'Sarah'): MantelItem => ({ photoId, fromName, keptAt: 5, url: `https://pictures.example/${photoId}.jpg` });

/** The television, as far as the one-second look and the keys go. */
function television() {
  const store = new QueueStore(noDisk());
  const channel = new FakeChannel();
  const engine = new BreakController();
  engine.setForeground(true, NOW);
  const running = startCardChannel(store, channel);
  const tv = {
    store,
    channel,
    engine,
    running,
    idle: IDLE_OFF as Idle,
    lastActiveAt: NOW,
    mantelAskedAt: null as number | null,
    mantelOpen: false,
    watching: false,
    /** What ResidentApp's look does, once: cards first, exactly as without a mantelpiece; then the idle screen. */
    async look(now: number) {
      let cards = await store.readAll();
      const picked = overMantel(engine.pickCard(cards, now), tv.mantelOpen);
      const showing = engine.noteShown(picked, cards, now);
      if (showing.began) {
        void store.enqueueOutbound({ t: 'card_shown', cardId: showing.began.id, at: now });
        await store.beginShowing(showing.began.id);
      }
      if (showing.ended) {
        await store.countShowing(showing.ended.id);
        cards = await store.readAll();
      }
      const waiting = engine.waiting(cards, now);
      const home = store.readHome();
      const seen = lookAtIdle({
        foreground: true, watching: tv.watching, mantelOpen: tv.mantelOpen, liveOpen: false, cardShowing: picked !== undefined, waiting: waiting !== undefined, home,
        now, idle: tv.idle, lastActiveAt: tv.lastActiveAt, mantel: store.readMantel(), askedAt: tv.mantelAskedAt, failed: [],
      });
      tv.lastActiveAt = seen.lastActiveAt;
      tv.idle = seen.idle;
      if (seen.ask) {
        tv.mantelAskedAt = now;
        await store.enqueueOutbound({ t: 'mantel', at: now });
      }
      return { card: picked, waiting: waiting ? waitingLine(waiting) : undefined, pill: offersMantel(home), idle: seen.idle.phase, picture: seen.picture?.photoId, sent: await store.drainOutbound() };
    },
    /** A key, as ResidentApp hears it. */
    key(eventType: string, eventKeyAction: number, now: number) {
      tv.lastActiveAt = now;
      tv.idle = idleOnKey(tv.idle, { eventType, eventKeyAction }, now);
    },
    /** A press on the card that is on screen, as ResidentApp's handleAction does it. */
    async press(card: QueuedCard, action: string, now: number) {
      if (blocksHome(tv.idle)) return;
      if (removesCard(card.card, action)) {
        engine.answered(card.id);
        await store.remove(card.id);
      }
      await store.enqueueOutbound({ t: 'card_action', cardId: card.id, action, at: now });
    },
  };
  return tv;
}

describe('a picture from the family, on her television', () => {
  it('waits for a quiet moment like any note, and is put away by "Keep it"', async () => {
    const tv = television();
    tv.channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    tv.channel.pushCard(photo());
    await settle();

    // Not at once (INV-5).
    expect((await tv.look(NOW + 1_000)).card).toBeUndefined();

    const shown = await tv.look(SETTLED);
    expect(shown.card?.card).toMatchObject({ type: 'PHOTO', headline: 'A picture from Sarah.', photoUrl: 'https://pictures.example/p9.jpg' });
    expect(shown.sent).toEqual([{ t: 'card_shown', cardId: 'photo-p9', at: SETTLED }]);

    await tv.press(shown.card!, PHOTO_ACTIONS.keep, SETTLED + 500);
    const after = await tv.look(SETTLED + 1_000);
    expect(after.card).toBeUndefined();
    expect(after.sent).toEqual([{ t: 'card_action', cardId: 'photo-p9', action: 'keep', at: SETTLED + 500 }]);

    // The home says there is now something on her mantelpiece: the pill is offered.
    tv.channel.pushControl({ t: 'home', home: { light: 'on', mantel: 1 }, whole: true });
    expect((await tv.look(SETTLED + 2_000)).pill).toBe(true);
    tv.running.stop();
  });

  it('comes back when her mantelpiece was full — the same card, with the line that says so — and is shown and counted as a new showing', async () => {
    const tv = television();
    tv.channel.pushControl({ t: 'home', home: { mantel: 12 }, whole: true });
    tv.channel.pushCard(photo());
    await settle();
    const shown = await tv.look(SETTLED);

    await tv.press(shown.card!, PHOTO_ACTIONS.keep, SETTLED + 300);
    // The server's answer arrives before the television has looked again: the same id, the showing it counted, and the notice.
    tv.channel.pushCard(photo({ notice: MANTEL_FULL_NOTICE }, 1));
    await settle();

    const again = await tv.look(SETTLED + 1_000);
    expect(again.card?.card).toMatchObject({ type: 'PHOTO', notice: MANTEL_FULL_NOTICE });
    // It is said to be shown again: nothing here took it for the card she had already answered.
    expect(again.sent).toEqual([
      { t: 'card_action', cardId: 'photo-p9', action: 'keep', at: SETTLED + 300 },
      { t: 'card_shown', cardId: 'photo-p9', at: SETTLED + 1_000 },
    ]);

    // She leaves it and starts a film: this showing is counted once, and it has had its two.
    tv.engine.setPlayback({ state: 'PLAYING', positionMs: 10_000, durationMs: 600_000, contentId: 'sintel' } as never, SETTLED + 5_000);
    tv.watching = true;
    await tv.look(SETTLED + 5_000);
    expect((await tv.store.readAll())[0]!.shownCount).toBe(2);

    // So it waits on the home screen, under who it is from.
    tv.engine.setPlayback(undefined, SETTLED + 60_000);
    tv.watching = false;
    const home = await tv.look(SETTLED + 120_000);
    expect(home.card).toBeUndefined();
    expect(home.waiting).toBe('A picture from Sarah is waiting.');
    tv.running.stop();
  });

  it('is put away by "Thank you" exactly as by "Keep it": nothing on the television tells the two apart but the press it sends', async () => {
    const tv = television();
    tv.channel.pushControl({ t: 'home', home: {}, whole: true });
    tv.channel.pushCard(photo());
    await settle();
    const shown = await tv.look(SETTLED);

    await tv.press(shown.card!, PHOTO_ACTIONS.thanks, SETTLED + 300);

    expect(await tv.store.readAll()).toEqual([]);
    expect((await tv.look(SETTLED + 1_000)).sent).toEqual([{ t: 'card_action', cardId: 'photo-p9', action: 'thanks', at: SETTLED + 300 }]);
    tv.running.stop();
  });
});

describe('a picture card that has waited longer than its address lives', () => {
  it('asks for its cards again, once, and shows the picture when the card comes back with a new address — its showings as they were', async () => {
    const store = new QueueStore(noDisk());
    let asked = 0;
    const channel = Object.assign(new FakeChannel(), { reconcile: async () => void (asked += 1) });
    const running = startCardChannel(store, channel);
    const refresh = pictureRefresher();
    /** What ResidentApp does when the card says its picture cannot be shown. */
    const pictureFailed = (cardId: string, now: number) => {
      if (refresh.due(cardId, now)) running.reconcile();
    };
    channel.pushCard(photo({ photoUrl: 'https://pictures.example/p9.jpg?expires=yesterday' }, 1));
    await settle();

    // The address no longer answers: the card says so, and again at a later look.
    pictureFailed('photo-p9', NOW);
    pictureFailed('photo-p9', NOW + 1_000);
    expect(asked).toBe(1);

    // The server's answer: the same card, with an address minted for this sending.
    channel.pushCard(photo({ photoUrl: 'https://pictures.example/p9.jpg?expires=in-an-hour' }, 1));
    await settle();
    const held = await store.readAll();
    expect(held).toHaveLength(1);
    expect(held[0]!.card).toMatchObject({ photoUrl: 'https://pictures.example/p9.jpg?expires=in-an-hour' });
    expect(held[0]!.shownCount).toBe(1);

    // If that one fails too, nothing more is asked: the card says the picture cannot be shown, and its buttons work.
    pictureFailed('photo-p9', NOW + 5_000);
    expect(asked).toBe(1);
    running.stop();
  });
});

describe('the mantelpiece open — a card that becomes showable meanwhile', () => {
  it('holds a note until she leaves, says nothing of it meanwhile, and lets the door through at once', async () => {
    const tv = television();
    tv.channel.pushControl({ t: 'home', home: { mantel: 2 }, whole: true });
    tv.mantelOpen = true;

    tv.channel.pushCard(photo());
    await settle();
    const behind = await tv.look(SETTLED);
    expect(behind.card).toBeUndefined();
    expect(behind.sent.filter((e) => e.t === 'card_shown')).toEqual([]);

    tv.channel.pushCard(door('door-1', SETTLED + 1_000));
    await settle();
    const rung = await tv.look(SETTLED + 2_000);
    expect(rung.card?.id).toBe('door-1');
    expect(rung.sent).toContainEqual({ t: 'card_shown', cardId: 'door-1', at: SETTLED + 2_000 });

    // The door is dealt with, and she leaves the mantelpiece: the note is shown then, for the first time.
    await tv.store.remove('door-1');
    tv.mantelOpen = false;
    const left = await tv.look(SETTLED + 10_000);
    expect(left.card?.id).toBe('photo-p9');
    expect(left.sent).toEqual([{ t: 'card_shown', cardId: 'photo-p9', at: SETTLED + 10_000 }]);
    expect((await tv.store.readAll()).find((c) => c.id === 'photo-p9')!.shownCount).toBe(0);
    tv.running.stop();
  });
});

describe('the idle screen — her pictures fill a home screen left untouched', () => {
  /** A home screen with something on her mantelpiece, last touched at NOW. */
  async function quietHome() {
    const tv = television();
    tv.channel.pushControl({ t: 'home', home: { light: 'on', mantel: 3 }, whole: true });
    await settle();
    return tv;
  }
  const IDLE_AT = NOW + MANTEL_IDLE_AFTER_MS;

  it('asks for her pictures when the few minutes are up, comes on when they arrive, and shows them one at a time', async () => {
    const tv = await quietHome();

    expect(await tv.look(IDLE_AT - 1_000)).toMatchObject({ idle: 'off', sent: [] });

    // Due: the pictures are asked for, once, and the home screen stays as it is until they come.
    expect(await tv.look(IDLE_AT)).toMatchObject({ idle: 'off', sent: [{ t: 'mantel', at: IDLE_AT }] });
    expect(await tv.look(IDLE_AT + 1_000)).toMatchObject({ idle: 'off', sent: [] });

    tv.channel.pushControl({ t: 'mantel', items: [kept('p1'), kept('p2', 'Tom'), kept('p3')] });
    // (The channel stamps the answer by the real clock; this test's clock is its own, so the answer is put on it.)
    tv.store.setMantel(tv.store.readMantel()!.items, IDLE_AT + 1_500);
    const from = IDLE_AT + 2_000;
    expect(await tv.look(from)).toMatchObject({ idle: 'on', picture: 'p1', sent: [] });
    expect(await tv.look(from + MANTEL_EACH_FOR_MS - 1_000)).toMatchObject({ idle: 'on', picture: 'p1' });
    expect(await tv.look(from + MANTEL_EACH_FOR_MS)).toMatchObject({ idle: 'on', picture: 'p2' });
    expect(await tv.look(from + 3 * MANTEL_EACH_FOR_MS)).toMatchObject({ idle: 'on', picture: 'p1' });
    tv.running.stop();
  });

  it('is ended at once by a card, which is shown by the ordinary rules: nothing is delayed', async () => {
    const tv = await quietHome();
    tv.channel.pushControl({ t: 'mantel', items: [kept('p1')] });
    tv.lastActiveAt = Date.now() - MANTEL_IDLE_AFTER_MS;
    const from = Date.now() + 1_000;
    // The engine's clock, brought to where this test's is.
    tv.engine.setForeground(false, from);
    tv.engine.setForeground(true, from - 60_000);
    expect((await tv.look(from)).idle).toBe('on');

    tv.channel.pushCard(photo());
    await settle();
    const withNote = await tv.look(from + 1_000);
    expect(withNote).toMatchObject({ idle: 'off', card: { id: 'photo-p9' } });
    expect(withNote.sent).toEqual([{ t: 'card_shown', cardId: 'photo-p9', at: from + 1_000 }]);

    // And the door, on a television whose pictures are up again.
    await tv.store.remove('photo-p9');
    tv.engine.answered('photo-p9');
    tv.lastActiveAt = from - MANTEL_IDLE_AFTER_MS;
    expect((await tv.look(from + 2_000)).idle).toBe('on');
    tv.channel.pushCard(door('door-2', from + 2_500));
    await settle();
    expect(await tv.look(from + 3_000)).toMatchObject({ idle: 'off', card: { id: 'door-2' } });
    tv.running.stop();
  });

  it('never comes on over a film, a waiting card, or a home with nothing kept — however long nothing is pressed', async () => {
    const long = NOW + 10 * MANTEL_IDLE_AFTER_MS;

    const film = await quietHome();
    film.channel.pushControl({ t: 'mantel', items: [kept('p1')] });
    film.watching = true;
    expect(await film.look(long)).toMatchObject({ idle: 'off', sent: [] });
    film.running.stop();

    const nothing = television();
    nothing.channel.pushControl({ t: 'home', home: { light: 'on' }, whole: true });
    expect(await nothing.look(long)).toMatchObject({ idle: 'off', sent: [] });
    nothing.running.stop();

    const waiting = await quietHome();
    waiting.channel.pushCard(photo({}, 2));
    await settle();
    expect(await waiting.look(long)).toMatchObject({ idle: 'off', waiting: 'A picture from Sarah is waiting.', sent: [] });
    waiting.running.stop();
  });

  it('is ended by any key — and that press does nothing else: no card is pressed, and the home screen is hers only once the key is up', async () => {
    const tv = await quietHome();
    tv.channel.pushControl({ t: 'mantel', items: [kept('p1')] });
    tv.lastActiveAt = Date.now() - MANTEL_IDLE_AFTER_MS;
    const from = Date.now() + 1_000;
    expect((await tv.look(from)).idle).toBe('on');
    expect(blocksHome(tv.idle)).toBe(true);

    tv.key('enter', 0, from + 500);
    expect(blocksHome(tv.idle)).toBe(true);
    // A picture arrives in that very moment, and OK coming up lands on its first button: it is not a press.
    tv.channel.pushCard(photo());
    await settle();
    await tv.press(photo(), PHOTO_ACTIONS.keep, from + 600);
    expect((await tv.store.readAll()).map((c) => c.id)).toEqual(['photo-p9']);
    expect((await tv.store.drainOutbound()).filter((e) => e.t === 'card_action')).toEqual([]);

    tv.key('enter', 1, from + 650);
    expect(blocksHome(tv.idle)).toBe(false);
    // And the few minutes start again from that key.
    await tv.store.remove('photo-p9');
    expect((await tv.look(from + 60_000)).idle).toBe('off');
    expect((await tv.look(from + 650 + MANTEL_IDLE_AFTER_MS)).idle).toBe('on');
    tv.running.stop();
  });

  it('asks again before the addresses run out, and not more than once a minute', async () => {
    const tv = await quietHome();
    tv.channel.pushControl({ t: 'mantel', items: [kept('p1')] });
    const received = tv.store.readMantel()!.receivedAt;
    tv.lastActiveAt = received - MANTEL_IDLE_AFTER_MS;
    expect(await tv.look(received + 1_000)).toMatchObject({ idle: 'on', sent: [] });

    const stale = received + MANTEL_FRESH_FOR_MS;
    expect((await tv.look(stale)).sent).toEqual([{ t: 'mantel', at: stale }]);
    expect((await tv.look(stale + 1_000)).sent).toEqual([]);
    expect((await tv.look(stale + 59_000)).sent).toEqual([]);
    expect((await tv.look(stale + 60_000)).sent).toEqual([{ t: 'mantel', at: stale + 60_000 }]);
    tv.running.stop();
  });
});

/*
 * Where the mantelpiece meets Hold for Sarah (home/reach.ts) and the wait
 * for the answer to her hold (home/asked.ts). The picture on her
 * mantelpiece keeps the hold (MantelScreen's onLongPress), and the offer it
 * brings is hers to see at once, over the mantelpiece — while a note still
 * waits behind it. The wait runs from when her question leaves the
 * television, as the card channel says it (startCardChannel's observer).
 */
describe('the mantelpiece open — her hold on the picture', () => {
  /** The television with her mantelpiece open, and the part of ResidentApp's look that decides which card is on screen. */
  function holding() {
    const store = new QueueStore(noDisk());
    const channel = new FakeChannel();
    const engine = new BreakController();
    engine.setForeground(true, NOW);
    const reachAsked = asking();
    const running = startCardChannel(store, channel, (event, at) => {
      if (event.t === 'reach') reachAsked.sent(event.at, at);
    });
    let openedId: string | null = null;
    return {
      store,
      channel,
      running,
      reachAsked,
      /** OK held on the picture: ResidentApp's handleHold. */
      async hold(at: number) {
        reachAsked.asked(at);
        await store.enqueueOutbound({ t: 'reach', at });
      },
      /** The card on screen, as the look finds it with the mantelpiece open. */
      async look(now: number) {
        let cards = await store.readAll();
        const picked = overMantel(engine.pickCard(cards, now), true);
        const reach = newestReachCard(cards);
        if (reach && reachAsked.waiting(now)) openedId = reach.id;
        const offers = reachOffersToPutAway(cards, openedId);
        for (const id of offers) await store.remove(id);
        if (offers.length > 0) cards = await store.readAll();
        const opened = openedId ? cards.find((c) => c.id === openedId) : undefined;
        if (openedId && !opened) openedId = null;
        return picked?.urgency === 'DOOR' ? picked : opened ?? picked;
      },
    };
  }
  const offer = (at: number): QueuedCard => buildReachAskCard({ householdId: 'hh-1', reachId: String(at), first: { userId: 'u_sarah', name: 'Sarah', role: 'organiser' }, now: at });

  it('brings the offer over the mantelpiece at once, while a picture that arrived meanwhile still waits behind it', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const tv = holding();
      tv.channel.pushCard(photo());
      await vi.advanceTimersByTimeAsync(0);

      await tv.hold(NOW);
      // The question leaves on the channel's next flush, and the wait for its answer runs from then.
      await vi.advanceTimersByTimeAsync(1_100);
      expect(tv.channel.sent).toEqual([{ t: 'reach', at: NOW }]);

      tv.channel.pushCard(offer(NOW + 1_500));
      await vi.advanceTimersByTimeAsync(0);

      const shown = await tv.look(NOW + 2_000);
      expect(shown?.card.type).toBe('REACH');
      // The picture is still held, not put away and not shown: it waits until she leaves the mantelpiece.
      expect((await tv.store.readAll()).map((c) => c.card.type).sort()).toEqual(['PHOTO', 'REACH']);
      tv.running.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the wait from when her question left, not from the hold: an offer that comes after a slow reconnect is still hers', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const tv = holding();
      // The channel is down when she holds, and for half a minute after.
      tv.channel.state = 'closed';
      await tv.hold(NOW);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tv.channel.sent).toEqual([]);

      tv.channel.state = 'open';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(tv.channel.sent).toEqual([{ t: 'reach', at: NOW }]);

      // More than the fifteen seconds after her hold, and well inside them after the question left.
      const arrives = NOW + 31_000 + LIGHT_ANSWER_WAIT_MS - 2_000;
      tv.channel.pushCard(offer(arrives));
      await vi.advanceTimersByTimeAsync(0);

      expect((await tv.look(arrives + 500))?.card.type).toBe('REACH');
      tv.running.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sends a hold that could not leave within a minute, and an offer nobody is waiting for is put away unseen — the mantelpiece stays as it was', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const tv = holding();
      tv.channel.state = 'closed';
      await tv.hold(NOW);
      await vi.advanceTimersByTimeAsync(ASK_SEND_WITHIN_MS + 1_000);

      tv.channel.state = 'open';
      await vi.advanceTimersByTimeAsync(2_000);
      expect(tv.channel.sent).toEqual([]);
      expect(tv.reachAsked.waiting(Date.now())).toBe(false);

      // An offer from some earlier hold turns up: she is not waiting for one.
      tv.channel.pushCard(offer(Date.now()));
      await vi.advanceTimersByTimeAsync(0);

      expect(await tv.look(Date.now() + 500)).toBeUndefined();
      expect(await tv.store.readAll()).toEqual([]);
      tv.running.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
