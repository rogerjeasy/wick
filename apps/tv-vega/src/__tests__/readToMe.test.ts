/**
 * Read to me (packages/contracts/src/speech.ts), from the key to the voice —
 * the parts ResidentApp.tsx and WatchScreen.tsx run, in the order they run
 * them, over a channel and a player that are not real ones.
 *
 * What Play does, in each place she can press it, is said here case by
 * case. The two screens are React components and are not rendered here (no
 * view in this app is); read/__tests__/app.test.ts holds them to using
 * these same parts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelState, ControlMessage, DeviceChannel, DeviceEvent } from '@wick/contracts';
import { QueueStore, type FileSystemLike } from '../headless/QueueStore.js';
import { IDLE_OFF, blocksHome, idleOnKey, type Idle } from '../mantel/idle.js';
import { Reader, type SpeechPlayer } from '../read/reading.js';
import { startCardChannel } from '../transport/startCardChannel.js';
import { lowerFilm } from '../watch/filmVolume.js';
import { playIsTheCards, readCommand, watchCommand } from '../watch/remoteKeys.js';

function noDisk(): FileSystemLike {
  const fail = () => Promise.reject(new Error('com.amazon.kepler.io.IoError'));
  return { exists: fail, readFileAsString: fail, writeStringToFile: fail };
}

class FakeChannel implements DeviceChannel {
  state: ChannelState = 'open';
  readonly sent: DeviceEvent[] = [];
  readonly #controls = new Set<(m: ControlMessage) => void>();
  async connect(): Promise<void> {}
  close(): void {
    this.state = 'closed';
  }
  onCard() {
    return () => undefined;
  }
  onControl(h: (m: ControlMessage) => void) {
    this.#controls.add(h);
    return () => this.#controls.delete(h);
  }
  async send(e: DeviceEvent): Promise<void> {
    this.sent.push(e);
  }
  pushControl(m: ControlMessage): void {
    for (const h of this.#controls) h(m);
  }
}

class FakeVoice implements SpeechPlayer {
  readonly said: string[] = [];
  readonly listeners = new Map<string, () => void>();
  async initialize(): Promise<void> {}
  async deinitialize(): Promise<void> {
    this.said.push('let go');
  }
  on(type: 'playing' | 'ended' | 'error', listener: () => void): void {
    this.listeners.set(type, listener);
  }
  load(url: string): void {
    this.said.push(`given ${url}`);
  }
  async play(): Promise<void> {
    this.said.push('play');
  }
  pause(): void {
    this.said.push('pause');
  }
}

const URL = 'https://speech.example/tts/hh-1/abc.mp3';
const DOWN = 0;
const UP = 1;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

/** The television: what is on screen, the film if there is one, and the keys as both screens hear them. */
function television(on: { card?: string; film?: 'playing' | 'paused'; holds?: boolean; canRead?: boolean }) {
  const store = new QueueStore(noDisk());
  const channel = new FakeChannel();
  const running = startCardChannel(store, channel);
  const voices: FakeVoice[] = [];
  /** The film's player, as WatchScreen has it: only ever toggled by `watchCommand`, only ever turned down by the reader. */
  const film = on.film ? { volume: 1, paused: on.film === 'paused', toggled: 0 } : null;
  const reader = new Reader({
    createPlayer: () => (voices.push(new FakeVoice()), voices[voices.length - 1]!),
    ask: (cardId) => void store.enqueueOutbound({ t: 'read', cardId, at: 1 }),
    lowerFilm: () => lowerFilm(film, () => true),
  });
  store.onSpeech((cardId, url) => reader.speech(cardId, url));
  const canRead = on.canRead !== false;
  const tv = {
    store,
    channel,
    running,
    reader,
    voices,
    film,
    card: undefined as string | undefined,
    /** Whether the card on screen is holding the film (BreakController.holdsProgramme): a note, never the door. */
    holds: on.holds === true,
    /** ResidentApp's `askedFor`: the card Play has already asked to have read, during this showing of it. */
    askedFor: null as string | null,
    /** The idle screen (mantel/idle.ts), as ResidentApp's `idleNow`: off, unless a test says her pictures are up. */
    idle: IDLE_OFF as Idle,
    /** The card on screen changes, as ResidentApp sees it: its `readingCard`, and the asking forgotten with the card. */
    show(cardId: string | undefined, holds = false) {
      tv.card = cardId;
      tv.holds = holds;
      const readingCard = canRead ? cardId : undefined;
      if (tv.askedFor !== null && tv.askedFor !== readingCard) tv.askedFor = null;
      reader.showing(readingCard);
    },
    /** One half of a key — going down, or coming up — to both screens, each with what the app knew when it arrived. */
    key(eventType: string, eventKeyAction: number, now = 0) {
      const event = { eventType, eventKeyAction };
      const readingCard = canRead ? tv.card : undefined;
      const context = {
        cardVisible: tv.card !== undefined,
        playReads: playIsTheCards({ card: readingCard, holdsFilm: tv.holds, askedFor: tv.askedFor }),
        reading: reader.state !== 'idle',
      };
      // ResidentApp's handler: Play for the reader — unless the idle screen takes this key — and then the idle rule.
      const read = readCommand(event, context);
      if (read && !blocksHome(tv.idle)) {
        reader.press(read);
        if (read === 'toggle' && readingCard !== undefined) tv.askedFor = readingCard;
      }
      tv.idle = idleOnKey(tv.idle, event, now);
      // WatchScreen's, when a film is on screen.
      if (film && watchCommand(event, context) === 'toggle') {
        film.paused = !film.paused;
        film.toggled += 1;
      }
    },
    /** One press of a key: down, then up. */
    press(eventType: string) {
      for (const eventKeyAction of [DOWN, UP]) tv.key(eventType, eventKeyAction);
    },
    /** The voice is heard. */
    heard() {
      voices[voices.length - 1]!.listeners.get('playing')!();
    },
    /** What went to the server, once the outbox has been flushed. */
    async sent() {
      await vi.advanceTimersByTimeAsync(1_100);
      return channel.sent;
    },
  };
  tv.show(on.card, on.holds === true);
  return tv;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Play, with no card on screen — as before', () => {
  it('on the home screen it does nothing: nothing is asked, nothing is read', async () => {
    const tv = television({});

    tv.press('play');
    tv.press('playpause');

    expect(await tv.sent()).toEqual([]);
    expect(tv.voices).toEqual([]);
    tv.running.stop();
  });

  it('over a film it pauses and resumes the film, and nothing is read', async () => {
    const tv = television({ film: 'playing' });

    tv.press('play');
    expect(tv.film).toMatchObject({ paused: true, toggled: 1 });
    tv.press('play');
    expect(tv.film).toMatchObject({ paused: false, toggled: 2, volume: 1 });

    expect(await tv.sent()).toEqual([]);
    expect(tv.voices).toEqual([]);
    tv.running.stop();
  });
});

describe('Play, with a card on the home screen', () => {
  it('asks for that card once, plays the answer for it, and stops on Play again', async () => {
    const tv = television({ card: 'note-1' });

    tv.press('play');
    expect(await tv.sent()).toEqual([{ t: 'read', cardId: 'note-1', at: 1 }]);
    expect(tv.voices).toEqual([]);

    tv.channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
    await settle();
    expect(tv.voices[0]!.said).toEqual([`given ${URL}`, 'play']);
    tv.voices[0]!.listeners.get('playing')!();
    expect(tv.reader.state).toBe('speaking');

    tv.press('play');
    await settle();
    expect(tv.voices[0]!.said).toEqual([`given ${URL}`, 'play', 'pause', 'let go']);
    expect(tv.reader.state).toBe('idle');
    // One asking, one reading: stopping asked for nothing.
    expect(await tv.sent()).toHaveLength(1);
    tv.running.stop();
  });

  it('goes on being the card’s: with no film there is nothing for Play to carry on with, so it reads, stops, and reads again', async () => {
    const tv = television({ card: 'note-1' });

    for (let round = 0; round < 2; round += 1) {
      tv.press('play');
      tv.channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
      await settle();
      tv.heard();
      tv.press('play');
      await settle();
      expect(tv.reader.state).toBe('idle');
    }

    expect((await tv.sent()).filter((event) => event.t === 'read')).toHaveLength(2);
    tv.running.stop();
  });

  it('plays nothing for an answer about a card that is no longer the one on screen', async () => {
    const tv = television({ card: 'note-1' });
    tv.press('play');

    tv.show('door-9');
    tv.channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
    await settle();

    expect(tv.voices).toEqual([]);
    expect(tv.reader.state).toBe('idle');
    tv.running.stop();
  });

  it('says and shows nothing when the server has nothing to read: an answer with no address', async () => {
    const tv = television({ card: 'note-1' });
    tv.press('play');

    tv.channel.pushControl({ t: 'speech', cardId: 'note-1' });
    await settle();

    expect(tv.voices).toEqual([]);
    expect(tv.reader.state).toBe('idle');
    tv.running.stop();
  });

  it('is cut short when the card is answered or taken back', async () => {
    const tv = television({ card: 'note-1' });
    tv.press('play');
    tv.channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
    await settle();
    tv.voices[0]!.listeners.get('playing')!();

    tv.show(undefined);
    await settle();

    expect(tv.voices[0]!.said.slice(-2)).toEqual(['pause', 'let go']);
    tv.running.stop();
  });
});

describe('Play, with a note holding the film (the film is paused on the cut while the note is on screen)', () => {
  const READ = [{ t: 'read', cardId: 'note-1', at: 1 }];
  /** The first Play, and the server's answer. */
  async function asked(url: string | null = URL) {
    const tv = television({ card: 'note-1', film: 'paused', holds: true });
    tv.press('play');
    tv.channel.pushControl({ t: 'speech', cardId: 'note-1', ...(url ? { url } : {}) });
    await settle();
    return tv;
  }

  it('the first Play reads the note, and the film stays held', async () => {
    const tv = await asked();
    tv.heard();

    expect(tv.reader.state).toBe('speaking');
    expect(tv.film).toMatchObject({ paused: true, toggled: 0 });
    expect(await tv.sent()).toEqual(READ);
  });

  it('the next Play, while it is still being read, stops the reading — and the film stays held: Play never moves the film under a card', async () => {
    const tv = await asked();
    tv.heard();

    tv.press('play');
    await settle();

    expect(tv.voices[0]!.said.slice(-2)).toEqual(['pause', 'let go']);
    expect(tv.reader.state).toBe('idle');
    expect(tv.film).toMatchObject({ paused: true, toggled: 0 });
    // Nothing more was asked: the second press stopped the reading, and that is all.
    expect(await tv.sent()).toEqual(READ);
  });

  it('the next Play, after the reading has ended, reads the note again; the film still waits for her answer', async () => {
    const tv = await asked();
    tv.heard();
    tv.voices[0]!.listeners.get('ended')!();
    await settle();

    tv.press('play');

    expect(tv.film).toMatchObject({ paused: true, toggled: 0 });
    expect((await tv.sent()).map((event) => event.t === 'read' && event.cardId)).toEqual(['note-1', 'note-1']);
  });

  it('when the asking failed quietly, Play asks again, and never moves the film', async () => {
    // No address in the answer.
    const nothing = await asked(null);
    expect(nothing.reader.state).toBe('idle');
    nothing.press('play');
    expect(nothing.film).toMatchObject({ paused: true, toggled: 0 });

    // No answer at all, and an answer that comes late: it is not played over the film, which has not moved.
    const unanswered = television({ card: 'note-1', film: 'paused', holds: true });
    unanswered.press('play');
    unanswered.press('play');
    expect(unanswered.film).toMatchObject({ paused: true, toggled: 0 });
  });

  it('reads every showing of every card on Play: another note, and the same one shown again later', async () => {
    const tv = await asked();
    tv.heard();

    // She answered; the film went on. At the next cut another note holds it.
    tv.show(undefined);
    tv.show('note-2', true);
    tv.press('play');
    expect(tv.film).toMatchObject({ toggled: 0 });
    expect((await tv.sent()).map((event) => event.t === 'read' && event.cardId)).toEqual(['note-1', 'note-2']);

    // And later the first note again: it is read again.
    tv.show(undefined);
    tv.show('note-1', true);
    tv.press('play');
    expect(tv.film).toMatchObject({ toggled: 0 });
    expect((await tv.sent()).map((event) => event.t === 'read' && event.cardId)).toEqual(['note-1', 'note-2', 'note-1']);
  });

  it('is her way back to the film at the first press where reading cannot work: nothing is asked, nothing is pressed twice', async () => {
    const tv = television({ card: 'note-1', film: 'paused', holds: true, canRead: false });

    tv.press('play');

    expect(tv.film).toMatchObject({ paused: false, toggled: 1 });
    expect(await tv.sent()).toEqual([]);
  });

  it('a key that is only Pause stops the reading and leaves the film held; with nothing being read it is the film’s, as before', async () => {
    const tv = await asked();
    tv.heard();

    tv.press('pause');
    await settle();
    expect(tv.reader.state).toBe('idle');
    expect(tv.film).toMatchObject({ paused: true, toggled: 0 });

    tv.press('pause');
    expect(tv.film).toMatchObject({ toggled: 1 });
  });
});

describe('Play, with the door’s card over a film that is playing (the door holds nothing)', () => {
  it('reads the card; the film is not paused, and is turned down for the voice and put back after it', async () => {
    const tv = television({ card: 'door-1', film: 'playing' });

    tv.press('play');
    expect(tv.film).toMatchObject({ paused: false, toggled: 0, volume: 1 });

    tv.channel.pushControl({ t: 'speech', cardId: 'door-1', url: URL });
    await settle();
    // Not before the voice is heard.
    expect(tv.film!.volume).toBe(1);
    tv.voices[0]!.listeners.get('playing')!();
    expect(tv.film).toMatchObject({ paused: false, toggled: 0, volume: 0.3 });

    tv.voices[0]!.listeners.get('ended')!();
    await settle();
    expect(tv.film).toMatchObject({ paused: false, toggled: 0, volume: 1 });
    tv.running.stop();
  });

  it('puts the film’s sound back when the reading is stopped, fails, or the card goes', async () => {
    const ways: Record<string, (tv: ReturnType<typeof television>) => void> = {
      'Play again': (tv) => tv.press('play'),
      'the dedicated Pause key': (tv) => tv.press('pause'),
      'the player fails': (tv) => tv.voices[0]!.listeners.get('error')!(),
      '"Not now" on the card': (tv) => tv.show(undefined),
      'the app goes behind another': (tv) => tv.reader.stop(),
    };
    for (const [way, out] of Object.entries(ways)) {
      const tv = television({ card: 'door-1', film: 'playing' });
      tv.press('play');
      tv.channel.pushControl({ t: 'speech', cardId: 'door-1', url: URL });
      await settle();
      tv.voices[0]!.listeners.get('playing')!();
      expect(tv.film!.volume, way).toBe(0.3);

      out(tv);
      await settle();

      expect(tv.film, way).toMatchObject({ volume: 1, paused: false, toggled: 0 });
      tv.running.stop();
    }
  });

  it('stops the reading on Play again, however often — and Play never pauses the film while the door’s card is up', async () => {
    const tv = television({ card: 'door-1', film: 'playing' });

    for (let round = 0; round < 3; round += 1) {
      tv.press('play');
      tv.channel.pushControl({ t: 'speech', cardId: 'door-1', url: URL });
      await settle();
      tv.heard();
      expect(tv.reader.state).toBe('speaking');
      tv.press('play');
      await settle();
      expect(tv.reader.state).toBe('idle');
    }

    expect(tv.film).toMatchObject({ paused: false, toggled: 0, volume: 1 });
    expect((await tv.sent()).filter((event) => event.t === 'read')).toHaveLength(3);
    tv.running.stop();
  });

  it('gives a key that is only Pause to the film when nothing is being read, as before there was reading', () => {
    const tv = television({ card: 'door-1', film: 'playing' });

    tv.press('pause');

    expect(tv.film).toMatchObject({ paused: true, toggled: 1 });
    expect(tv.reader.state).toBe('idle');
    tv.running.stop();
  });

  it('leaves the skip keys to the film, as before', () => {
    const tv = television({ card: 'door-1', film: 'playing' });

    expect(watchCommand({ eventType: 'forward', eventKeyAction: DOWN }, { cardVisible: true, playReads: true })).toBe('forward');
    expect(readCommand({ eventType: 'forward', eventKeyAction: DOWN }, { cardVisible: true, playReads: true })).toBeUndefined();
    tv.running.stop();
  });
});

describe('where reading cannot work', () => {
  it('Play over a card is the film’s, exactly as it was: nothing is asked, and the film pauses', async () => {
    const tv = television({ card: 'door-1', film: 'playing', canRead: false });

    tv.press('play');

    expect(tv.film).toMatchObject({ paused: true, toggled: 1 });
    expect(await tv.sent()).toEqual([]);
    tv.running.stop();
  });
});

/*
 * Where read to me meets the idle screen (mantel/idle.ts). Any key ends her
 * pictures, and that key does nothing else — so it is not Play for a card
 * that arrived in that moment, however long it is held. ResidentApp hears
 * every key in one place, and asks the idle rule before the reader is told.
 */
describe('Play, on the key that ends the idle screen', () => {
  it('ends her pictures and reads nothing — not on the press, and not while it is held over a card that arrived meanwhile', async () => {
    const tv = television({});
    tv.idle = { phase: 'on', startedAt: 0 };

    tv.key('playpause', DOWN, 1_000);
    expect(tv.idle).toEqual({ phase: 'ending', key: 'playpause', at: 1_000 });

    // A note becomes showable in that moment, and the key — still down — repeats.
    tv.show('note-1');
    tv.key('playpause', DOWN, 1_200);
    tv.key('playpause', DOWN, 1_400);
    expect(await tv.sent()).toEqual([]);
    expect(tv.reader.state).toBe('idle');
    expect(tv.askedFor).toBeNull();

    // The key is up: the home screen is hers again, and the next Play is the card's.
    tv.key('playpause', UP, 1_500);
    expect(tv.idle).toEqual(IDLE_OFF);
    tv.press('playpause');
    expect(await tv.sent()).toEqual([{ t: 'read', cardId: 'note-1', at: 1 }]);
    tv.running.stop();
  });

  it('takes Play too when another key ended the idle screen and has not come up: pressed at a screen that could not answer it', async () => {
    const tv = television({});
    tv.idle = { phase: 'on', startedAt: 0 };
    tv.key('enter', DOWN, 1_000);
    tv.show('note-1');

    tv.key('play', DOWN, 1_100);
    expect(tv.idle).toEqual({ phase: 'ending', key: 'play', at: 1_100 });
    expect(await tv.sent()).toEqual([]);
    expect(tv.voices).toEqual([]);

    tv.key('play', UP, 1_200);
    expect(tv.idle).toEqual(IDLE_OFF);
    tv.running.stop();
  });

  it('does not stop a reading either: a key the idle screen took is not the reader’s in any way', async () => {
    const tv = television({ card: 'note-1' });
    tv.press('play');
    tv.channel.pushControl({ t: 'speech', cardId: 'note-1', url: URL });
    await settle();
    tv.heard();
    expect(tv.reader.state).not.toBe('idle');

    // Cannot happen as the look runs — her pictures are never up over a card — but if the two ever met, the key is the idle screen's.
    tv.idle = { phase: 'on', startedAt: 0 };
    tv.key('play', DOWN, 2_000);

    expect(tv.reader.state).not.toBe('idle');
    expect(tv.voices[0]!.said).not.toContain('pause');
    tv.running.stop();
  });

  it('changes nothing while the idle screen is off: Play reads the card as it always did', async () => {
    const tv = television({ card: 'note-1' });
    expect(tv.idle).toEqual(IDLE_OFF);

    tv.press('play');

    expect(await tv.sent()).toEqual([{ t: 'read', cardId: 'note-1', at: 1 }]);
    expect(tv.idle).toEqual(IDLE_OFF);
    tv.running.stop();
  });
});
