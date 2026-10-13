import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lowerFilm } from '../../watch/filmVolume.js';
import { READ_ANSWER_WAIT_MS, READ_START_WAIT_MS, Reader, speechAddress, type ReadingState, type SpeechPlayer } from '../reading.js';

const URL_1 = 'https://speech.example/tts/hh-1/abc.mp3?X-Amz-Signature=s';

/** A player that does what it is told and says what it is told to say — never the television's. */
class FakePlayer implements SpeechPlayer {
  readonly calls: string[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  failInitialize = false;
  failPlay = false;
  failDeinitialize = false;
  holdInitialize: (() => void) | undefined;
  heldInitialize = false;

  async initialize(): Promise<void> {
    this.calls.push('initialize');
    if (this.heldInitialize) await new Promise<void>((resolve) => (this.holdInitialize = resolve));
    if (this.failInitialize) throw new Error('no_audio');
  }
  async deinitialize(): Promise<void> {
    this.calls.push('deinitialize');
    if (this.failDeinitialize) throw new Error('already_gone');
  }
  on(type: 'playing' | 'ended' | 'error', listener: () => void): void {
    this.calls.push(`on:${type}`);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  load(url: string): void {
    this.calls.push(`load:${url}`);
  }
  async play(): Promise<void> {
    this.calls.push('play');
    if (this.failPlay) throw new Error('not_allowed');
  }
  pause(): void {
    this.calls.push('pause');
  }
  say(type: 'playing' | 'ended' | 'error'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  get count(): Record<string, number> {
    return { deinitialize: this.calls.filter((c) => c === 'deinitialize').length, play: this.calls.filter((c) => c === 'play').length };
  }
}

/** Lets the promises in a reading's start settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function television(setup: (player: FakePlayer) => void = () => undefined) {
  const players: FakePlayer[] = [];
  const asked: string[] = [];
  const states: ReadingState[] = [];
  const film = { volume: 1 };
  const reader = new Reader({
    createPlayer: () => {
      const player = new FakePlayer();
      setup(player);
      players.push(player);
      return player;
    },
    ask: (cardId) => asked.push(cardId),
    lowerFilm: () => lowerFilm(film),
    onChange: (state) => states.push(state),
  });
  return { reader, players, asked, states, film };
}

/** A card on screen, Play pressed, and the server's answer taken in. */
async function started(setup?: (player: FakePlayer) => void) {
  const tv = television(setup);
  tv.reader.showing('note-1');
  tv.reader.press('toggle');
  tv.reader.speech('note-1', URL_1);
  await settle();
  return { ...tv, player: tv.players[0]! };
}

/** …and the voice heard. */
async function speaking() {
  const tv = await started();
  tv.player.say('playing');
  return tv;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('speechAddress — a reading is fetched only from an https address', () => {
  it('takes an https address as it is, and nothing else', () => {
    expect(speechAddress(URL_1)).toBe(URL_1);
    for (const not of [undefined, null, '', 'http://speech.example/a.mp3', 'file:///data/a.mp3', 'data:audio/mpeg;base64,AAAA', 7, {}]) {
      expect(speechAddress(not)).toBeUndefined();
    }
  });
});

describe('Reader — asking', () => {
  it('does nothing when no card is on screen: Play is then not the card’s', () => {
    const tv = television();

    tv.reader.press('toggle');
    tv.reader.press('stop');

    expect(tv.asked).toEqual([]);
    expect(tv.reader.state).toBe('idle');
    expect(tv.players).toEqual([]);
  });

  it('asks for the card on screen, once, and waits for the answer for that card', () => {
    const tv = television();
    tv.reader.showing('note-1');

    tv.reader.press('toggle');

    expect(tv.asked).toEqual(['note-1']);
    expect(tv.reader.state).toBe('asking');
    expect(tv.players).toEqual([]);
  });

  it('takes no notice of an answer about another card, or one it did not ask for', async () => {
    const tv = television();
    tv.reader.showing('note-1');
    tv.reader.speech('note-1', URL_1);
    await settle();
    expect(tv.players).toEqual([]);

    tv.reader.press('toggle');
    tv.reader.speech('door-9', URL_1);
    await settle();

    expect(tv.reader.state).toBe('asking');
    expect(tv.players).toEqual([]);
  });

  it('says and shows nothing when the answer has no address, or one that is not https: a quiet nothing, and she can ask again', async () => {
    for (const url of [undefined, '', 'http://speech.example/a.mp3', 7]) {
      const tv = television();
      tv.reader.showing('note-1');
      tv.reader.press('toggle');

      tv.reader.speech('note-1', url);
      await settle();

      expect(tv.reader.state).toBe('idle');
      expect(tv.players).toEqual([]);
      tv.reader.press('toggle');
      expect(tv.asked).toEqual(['note-1', 'note-1']);
    }
  });

  it('stops waiting when Play is pressed again before the answer, and the answer that then comes is not played', async () => {
    const tv = television();
    tv.reader.showing('note-1');
    tv.reader.press('toggle');

    tv.reader.press('toggle');
    tv.reader.speech('note-1', URL_1);
    await settle();

    expect(tv.asked).toEqual(['note-1']);
    expect(tv.reader.state).toBe('idle');
    expect(tv.players).toEqual([]);
  });

  it('gives up waiting for an answer that never comes, so the next press asks again instead of "stopping" nothing', () => {
    const tv = television();
    tv.reader.showing('note-1');
    tv.reader.press('toggle');

    vi.advanceTimersByTime(READ_ANSWER_WAIT_MS - 1);
    expect(tv.reader.state).toBe('asking');
    vi.advanceTimersByTime(1);
    expect(tv.reader.state).toBe('idle');

    tv.reader.press('toggle');
    expect(tv.asked).toEqual(['note-1', 'note-1']);
  });

  it('never stops anything on a key that is only Pause when nothing is being read', () => {
    const tv = television();
    tv.reader.showing('note-1');

    tv.reader.press('stop');

    expect(tv.asked).toEqual([]);
    expect(tv.reader.state).toBe('idle');
  });
});

describe('Reader — playing, by the recipe the Vega simulator was seen to follow', () => {
  it('makes one player for the reading: initialise, listen, give it the address, play', async () => {
    const { player, reader, players } = await started();

    expect(players).toHaveLength(1);
    expect(player.calls).toEqual(['initialize', 'on:playing', 'on:ended', 'on:error', `load:${URL_1}`, 'play']);
    // play() answers at once, long before any sound: it has not started until the player says so.
    expect(reader.state).toBe('starting');
  });

  it('listens for those three things and no others: the Fire OS player has no more', async () => {
    const { player } = await started();

    expect([...player.listeners.keys()].sort()).toEqual(['ended', 'error', 'playing']);
  });

  it('has started when the player says "playing"', async () => {
    const { player, reader } = await started();

    player.say('playing');

    expect(reader.state).toBe('speaking');
  });

  it('is torn down when the reading ends', async () => {
    const { player, reader } = await speaking();

    player.say('ended');
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
  });

  it('is torn down on an error, quietly', async () => {
    const { player, reader } = await speaking();

    player.say('error');
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
  });

  it('can be read again, and again: a new player each time, each one torn down', async () => {
    const tv = await speaking();
    tv.player.say('ended');
    for (let i = 0; i < 2; i += 1) {
      tv.reader.press('toggle');
      tv.reader.speech('note-1', URL_1);
      await settle();
      tv.players[tv.players.length - 1]!.say('playing');
      tv.players[tv.players.length - 1]!.say('ended');
    }
    await settle();

    expect(tv.players).toHaveLength(3);
    expect(tv.players.map((p) => p.count.deinitialize)).toEqual([1, 1, 1]);
    expect(tv.asked).toEqual(['note-1', 'note-1', 'note-1']);
  });

  it('says how it stands at each step, for the screen', async () => {
    const tv = await speaking();
    tv.player.say('ended');

    expect(tv.states).toEqual(['asking', 'starting', 'speaking', 'idle']);
  });
});

describe('Reader — stopping', () => {
  it('stops on Play pressed again while it is reading: silence at once, and the player let go', async () => {
    const { player, reader, asked } = await speaking();

    reader.press('toggle');
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.calls.slice(-2)).toEqual(['pause', 'deinitialize']);
    expect(asked).toEqual(['note-1']);
  });

  it('stops on Play pressed again before the voice has started', async () => {
    const { player, reader } = await started();

    reader.press('toggle');
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
  });

  it('stops on a key that is only Pause', async () => {
    const { player, reader } = await speaking();

    reader.press('stop');
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
  });

  it('stops when the card leaves the screen — answered, taken back, or the door come over it', async () => {
    for (const next of [undefined, 'door-9']) {
      const { player, reader } = await speaking();

      reader.showing(next);
      await settle();

      expect(reader.state).toBe('idle');
      expect(player.calls.slice(-2)).toEqual(['pause', 'deinitialize']);
    }
  });

  it('goes on when the same card is drawn again: sent again in her language, or patched', async () => {
    const { player, reader } = await speaking();

    reader.showing('note-1');

    expect(reader.state).toBe('speaking');
    expect(player.count.deinitialize).toBe(0);
  });

  it('stops when the app leaves the screen or is closed', async () => {
    const { player, reader } = await speaking();

    reader.stop();
    await settle();

    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
  });

  it('stops waiting for an answer when the card leaves, and does not play the answer when it comes', async () => {
    const tv = television();
    tv.reader.showing('note-1');
    tv.reader.press('toggle');

    tv.reader.showing(undefined);
    tv.reader.speech('note-1', URL_1);
    await settle();

    expect(tv.reader.state).toBe('idle');
    expect(tv.players).toEqual([]);
  });

  it('lets a player go that was still being made ready when the card left — and never gives it the address', async () => {
    const tv = television((player) => {
      player.heldInitialize = true;
    });
    tv.reader.showing('note-1');
    tv.reader.press('toggle');
    tv.reader.speech('note-1', URL_1);
    await settle();
    const player = tv.players[0]!;

    tv.reader.showing(undefined);
    player.holdInitialize!();
    await settle();

    expect(player.calls).toEqual(['initialize', 'deinitialize']);
    expect(tv.reader.state).toBe('idle');
  });

  it('tears a player down once, however many reasons there are', async () => {
    const { player, reader } = await speaking();

    reader.press('toggle');
    reader.showing(undefined);
    reader.stop();
    player.say('ended');
    player.say('error');
    await settle();

    expect(player.count.deinitialize).toBe(1);
  });

  it('takes no notice of a player it has let go: what that one says later changes nothing', async () => {
    const tv = await started();
    tv.reader.press('toggle');
    await settle();

    tv.player.say('playing');
    tv.player.say('ended');

    expect(tv.reader.state).toBe('idle');
    expect(tv.film.volume).toBe(1);
    expect(tv.states).toEqual(['asking', 'starting', 'idle']);
  });
});

describe('Reader — failing quietly: no line on her screen, nothing spoken, and she can ask again', () => {
  it('gives up on an address that never starts to play, about six seconds after it was given', async () => {
    const { player, reader, asked } = await started();

    vi.advanceTimersByTime(READ_START_WAIT_MS - 1);
    expect(reader.state).toBe('starting');
    vi.advanceTimersByTime(1);
    await settle();

    expect(READ_START_WAIT_MS).toBe(6_000);
    expect(reader.state).toBe('idle');
    expect(player.count.deinitialize).toBe(1);
    reader.press('toggle');
    expect(asked).toEqual(['note-1', 'note-1']);
  });

  it('does not give up on a reading that has started: a card can take forty seconds to read', async () => {
    const { reader } = await speaking();

    vi.advanceTimersByTime(60_000);

    expect(reader.state).toBe('speaking');
  });

  it('is quiet when the player cannot be made, cannot be made ready, or will not play', async () => {
    const broken = television();
    const reader = new Reader({
      createPlayer: () => {
        throw new Error('no such module');
      },
      ask: () => undefined,
    });
    reader.showing('note-1');
    reader.press('toggle');
    expect(() => reader.speech('note-1', URL_1)).not.toThrow();
    await settle();
    expect(reader.state).toBe('idle');
    expect(broken.players).toEqual([]);

    const noInit = await started((player) => {
      player.failInitialize = true;
    });
    expect(noInit.reader.state).toBe('idle');
    expect(noInit.player.calls).toEqual(['initialize', 'deinitialize']);

    const noPlay = await started((player) => {
      player.failPlay = true;
    });
    expect(noPlay.reader.state).toBe('idle');
    expect(noPlay.player.count.deinitialize).toBe(1);
  });

  it('is not troubled by a player that fails as it is let go', async () => {
    const { player, reader } = await started((p) => {
      p.failDeinitialize = true;
    });

    player.say('playing');
    player.say('ended');
    await settle();

    expect(reader.state).toBe('idle');
  });
});

describe('Reader — the film that is playing under the door’s card', () => {
  it('is turned down when the voice starts — not before — and put back exactly when the reading ends', async () => {
    const tv = await started();
    expect(tv.film.volume).toBe(1);

    tv.player.say('playing');
    expect(tv.film.volume).toBe(0.3);

    tv.player.say('ended');
    expect(tv.film.volume).toBe(1);
  });

  it('is put back on every way out', async () => {
    const ways: Record<string, (tv: Awaited<ReturnType<typeof started>>) => void> = {
      'the reading ends': (tv) => tv.player.say('ended'),
      'the player fails': (tv) => tv.player.say('error'),
      'Play is pressed again': (tv) => tv.reader.press('toggle'),
      'Pause is pressed': (tv) => tv.reader.press('stop'),
      'the card is answered or taken back': (tv) => tv.reader.showing(undefined),
      'another card comes over it': (tv) => tv.reader.showing('door-10'),
      'the app leaves the screen': (tv) => tv.reader.stop(),
    };
    for (const [way, out] of Object.entries(ways)) {
      const tv = await started();
      tv.film.volume = 0.8;
      tv.player.say('playing');
      expect(tv.film.volume, way).toBe(0.3);

      out(tv);
      await settle();

      expect(tv.film.volume, way).toBe(0.8);
      expect(tv.reader.state, way).toBe('idle');
    }
  });

  it('is never touched by a reading that never starts: no answer, no address, a dead address, a player that fails', async () => {
    const dead = await started();
    vi.advanceTimersByTime(READ_START_WAIT_MS);
    await settle();
    expect(dead.film.volume).toBe(1);

    const failing = await started((player) => {
      player.failPlay = true;
    });
    expect(failing.film.volume).toBe(1);

    const unanswered = television();
    unanswered.reader.showing('note-1');
    unanswered.reader.press('toggle');
    unanswered.reader.speech('note-1', undefined);
    await settle();
    expect(unanswered.film.volume).toBe(1);
  });

  it('is turned down once, though the player says "playing" twice', async () => {
    const tv = await speaking();
    tv.player.say('playing');
    tv.player.say('ended');

    expect(tv.film.volume).toBe(1);
  });

  it('is not needed: a reader with no film to lower reads all the same', async () => {
    const players: FakePlayer[] = [];
    const reader = new Reader({ createPlayer: () => (players.push(new FakePlayer()), players[players.length - 1]!), ask: () => undefined });
    reader.showing('note-1');
    reader.press('toggle');
    reader.speech('note-1', URL_1);
    await settle();

    players[0]!.say('playing');
    players[0]!.say('ended');

    expect(reader.state).toBe('idle');
  });
});
