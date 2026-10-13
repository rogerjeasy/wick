/**
 * Read to me (packages/contracts/src/speech.ts): a card read aloud, when
 * she asks. Not everyone who watches television can read one from across
 * the room.
 *
 * While a card is on her screen the Play key asks for it to be read: the
 * television sends `{t:'read', cardId}` once, and waits for the `speech`
 * control for that card — a short-lived address of the reading, answered to
 * this television only. It is played beside whatever is on screen. Play
 * again stops it.
 *
 * Only when she asks: nothing here ever starts a reading by itself. And
 * when a reading cannot be had — no answer, no address, an address that
 * does not play — it fails quietly: nothing is said, no line is put on her
 * screen, and she can ask again.
 *
 * One player for each reading, by the recipe seen to work on the Vega
 * simulator (2026-10-13): make it, `initialize()`, listen, give it the
 * address, `play()`. `play()` answers at once, long before any sound, so a
 * reading has started when the player says `playing`; it is let go on
 * `ended`, on `error`, when the card leaves the screen for any reason — a
 * press, a revoke, the door coming over it, the app going behind another —
 * and when the app is closed. Only those three events are listened for:
 * the Fire OS player has no others.
 *
 * A film playing under the card — only ever the door's card, since every
 * other card holds the film — is turned down when the voice starts and put
 * back exactly when the reading is over, on every way out
 * (watch/filmVolume.ts).
 *
 * Pure but for the clock's timers: the player, the sending and the film are
 * handed in, so this is tested without a television or a sound.
 */
import type { ReadCommand } from '../watch/remoteKeys.js';

/** The little of an audio player a reading needs (read/speechPlayer.ts makes one from the platform's). */
export interface SpeechPlayer {
  initialize(): Promise<void>;
  deinitialize(): Promise<unknown>;
  on(type: 'playing' | 'ended' | 'error', listener: () => void): void;
  /** Gives it the address to play. */
  load(url: string): void;
  play(): Promise<void>;
  pause(): void;
}

/**
 * idle — nothing asked; asking — `read` sent, no answer yet; starting — the
 * player has the address and has not been heard; speaking — it has.
 */
export type ReadingState = 'idle' | 'asking' | 'starting' | 'speaking';

export interface ReaderDeps {
  /** A new player, for one reading. */
  readonly createPlayer: () => SpeechPlayer;
  /** Sends `{t:'read', cardId}`. */
  readonly ask: (cardId: string) => void;
  /** Turns down a film that is playing, and gives back the way to put it as it was (watch/filmVolume.ts). */
  readonly lowerFilm?: (() => () => void) | undefined;
  /** How it stands now, for the screen. */
  readonly onChange?: ((state: ReadingState) => void) | undefined;
}

/** How long an answer is waited for. After it, Play asks again instead of "stopping" something that never came. */
export const READ_ANSWER_WAIT_MS = 10_000;
/** How long an address may take to start playing: on the simulator it took a third of a second. A dead one fails quietly. */
export const READ_START_WAIT_MS = 6_000;

/** The address a reading is fetched from: https, or none. */
export function speechAddress(url: unknown): string | undefined {
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}

export class Reader {
  readonly #deps: ReaderDeps;
  #state: ReadingState = 'idle';
  /** The card on screen now. */
  #showing: string | undefined;
  /** The card the reading under way is of. */
  #reading: string | undefined;
  /**
   * The player of the reading under way, with how far it has got: the
   * platform's player must not be told anything until `initialize()` has
   * answered, and has nothing to pause until it has been given an address.
   */
  #player: { readonly player: SpeechPlayer; ready: Promise<unknown>; loaded: boolean } | undefined;
  /** Which reading this is: what an earlier one's player says later is not about this one. */
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #restoreFilm: (() => void) | undefined;

  constructor(deps: ReaderDeps) {
    this.#deps = deps;
  }

  get state(): ReadingState {
    return this.#state;
  }

  /** The card that is on screen now, or none. A reading of any other card is over. */
  showing(cardId: string | undefined): void {
    this.#showing = cardId;
    if (this.#state !== 'idle' && this.#reading !== cardId) this.#end();
  }

  /** Play — ask, or stop — or a key that is only Pause, which only ever stops (watch/remoteKeys.ts readCommand). */
  press(command: ReadCommand): void {
    if (this.#state !== 'idle') {
      this.#end();
      return;
    }
    if (command !== 'toggle' || this.#showing === undefined) return;
    this.#reading = this.#showing;
    this.#run += 1;
    this.#set('asking');
    this.#wait(READ_ANSWER_WAIT_MS);
    this.#deps.ask(this.#showing);
  }

  /** The server's answer. Only the one asked for, for the card still on screen, is played. */
  speech(cardId: string, url: unknown): void {
    if (this.#state !== 'asking' || cardId !== this.#reading || cardId !== this.#showing) return;
    const address = speechAddress(url);
    // Nothing to read, or it could not be made: nothing is said, and nothing shown.
    if (!address) {
      this.#end();
      return;
    }
    void this.#play(address);
  }

  /** The app has left the screen, or is closing. */
  stop(): void {
    if (this.#state !== 'idle') this.#end();
  }

  async #play(address: string): Promise<void> {
    const run = this.#run;
    const mine = (): boolean => run === this.#run && this.#state !== 'idle';
    this.#clearTimer();
    this.#set('starting');

    let player: SpeechPlayer;
    try {
      player = this.#deps.createPlayer();
    } catch {
      this.#end();
      return;
    }
    const held = { player, ready: Promise.resolve() as Promise<unknown>, loaded: false };
    this.#player = held;
    try {
      const ready = player.initialize();
      // Whoever lets it go waits for this, whether it answers or fails.
      held.ready = ready.catch(() => undefined);
      await ready;
      // The card left while the player was being made ready: #end has let it go already.
      if (!mine()) return;
      player.on('playing', () => {
        if (!mine() || this.#state === 'speaking') return;
        this.#clearTimer();
        this.#restoreFilm = this.#deps.lowerFilm?.();
        this.#set('speaking');
      });
      player.on('ended', () => {
        if (mine()) this.#end();
      });
      player.on('error', () => {
        if (mine()) this.#end();
      });
      player.load(address);
      held.loaded = true;
      this.#wait(READ_START_WAIT_MS);
      await player.play();
    } catch {
      if (mine()) this.#end();
    }
  }

  /** Every way out comes through here: the timer, the film, the player, and how it stands. Once for each reading. */
  #end(): void {
    this.#clearTimer();
    this.#run += 1;
    this.#reading = undefined;
    const restore = this.#restoreFilm;
    this.#restoreFilm = undefined;
    restore?.();
    const held = this.#player;
    this.#player = undefined;
    if (held) {
      if (held.loaded) {
        try {
          // Silence at once; letting it go takes a moment longer.
          held.player.pause();
        } catch {
          // Gone already.
        }
      }
      // Never before it has been made ready — and never left behind, whether or not it was.
      void held.ready.then(() => held.player.deinitialize()).catch(() => undefined);
    }
    this.#set('idle');
  }

  #wait(ms: number): void {
    this.#clearTimer();
    const run = this.#run;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (run === this.#run) this.#end();
    }, ms);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #set(state: ReadingState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#deps.onChange?.(state);
  }
}
