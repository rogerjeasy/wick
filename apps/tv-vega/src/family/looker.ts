/**
 * When a family member's own television asks the Wick server again, and
 * what it makes of the answers. Pure — no React, no network of its own: it
 * is given the one look to make (family/familyClient.ts `home`) and told
 * when the app is on screen.
 *
 * It looks as soon as it starts, then every FAMILY_TV_LOOK_EVERY_MS while
 * the app is on screen; not at all while it is off screen, and at once on
 * the way back. Never two looks out at once.
 *
 * A look that fails changes nothing on screen: the last good home stays,
 * and the next look is at the next interval. After three in a row the
 * screen says, quietly, that Wick cannot reach the home — and the looks go
 * on. Nothing here counts down and nothing is taken off the screen by a
 * timer: the only thing a timer does is ask again.
 */
import { FAMILY_TV_LOOK_EVERY_MS, type FamilyTvHome } from '@wick/contracts';
import type { HomeAnswer } from './familyClient.js';

/** This many failed looks in a row, and a screen that is showing a home says so. One that has never reached a home says so after the first. */
export const FAILED_LOOKS_BEFORE_SAYING = 3;

export type LookState =
  /** No answer yet. Nothing of a home is shown — and nothing in its place, unless Wick cannot reach it. */
  | { readonly kind: 'starting'; readonly unreachable: boolean }
  /** The last home the server gave, and whether the looks since have been failing. */
  | { readonly kind: 'home'; readonly home: FamilyTvHome; readonly unreachable: boolean }
  /** The resident has not allowed this member, or no longer does: the server's sentence, and nothing else. */
  | { readonly kind: 'notAllowed'; readonly say: string }
  /** This television is no longer connected. Final: the app forgets its token and shows the pairing screen. */
  | { readonly kind: 'signedOut' };

export interface FamilyLookerDeps {
  readonly look: () => Promise<HomeAnswer>;
  /** Told only when what the screen should show has changed. */
  readonly onChange: (state: LookState) => void;
  readonly everyMs?: number;
}

const same = (a: LookState, b: LookState): boolean => JSON.stringify(a) === JSON.stringify(b);

export class FamilyLooker {
  readonly #deps: FamilyLookerDeps;
  readonly #everyMs: number;
  #state: LookState = { kind: 'starting', unreachable: false };
  #failures = 0;
  #started = false;
  #stopped = false;
  #onScreen = true;
  #timer: ReturnType<typeof setInterval> | undefined;
  #out: Promise<void> | undefined;
  /** A look was asked for while one was out: that one may have been answered before what prompted this. */
  #again = false;

  constructor(deps: FamilyLookerDeps) {
    this.#deps = deps;
    this.#everyMs = deps.everyMs ?? FAMILY_TV_LOOK_EVERY_MS;
  }

  get state(): LookState {
    return this.#state;
  }

  /** The family screen is up. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    if (this.#onScreen) this.#begin();
  }

  /** The family screen is gone. An answer still on its way is dropped. */
  stop(): void {
    this.#stopped = true;
    this.#rest();
  }

  /** Whether Wick is the app on screen (App.tsx `useOnScreen`). */
  setOnScreen(onScreen: boolean): void {
    if (onScreen === this.#onScreen) return;
    this.#onScreen = onScreen;
    if (!this.#started) return;
    if (onScreen) this.#begin();
    else this.#rest();
  }

  /** After a press: what the home says now, without waiting for the interval. */
  lookNow(): Promise<void> {
    if (this.#out) {
      this.#again = true;
      return this.#out;
    }
    return this.#look();
  }

  /** "Not allowed" or "signed out", heard in answer to a press rather than a look. */
  heard(answer: Extract<HomeAnswer, { kind: 'notAllowed' | 'signedOut' }>): void {
    if (this.#over()) return;
    this.#take(answer);
  }

  #over(): boolean {
    return this.#stopped || this.#state.kind === 'signedOut';
  }

  #begin(): void {
    this.#rest();
    if (this.#over()) return;
    void this.#look();
    this.#timer = setInterval(() => void this.#look(), this.#everyMs);
  }

  #rest(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #look(): Promise<void> {
    if (this.#over()) return Promise.resolve();
    // Never two at once: whoever asks while one is out waits for that one.
    if (this.#out) return this.#out;
    this.#out = (async () => {
      const answer = await this.#deps.look().catch((): HomeAnswer => ({ kind: 'failed' }));
      this.#out = undefined;
      if (this.#over()) return;
      this.#take(answer);
      if (this.#again) {
        this.#again = false;
        await this.#look();
      }
    })();
    return this.#out;
  }

  #take(answer: HomeAnswer): void {
    switch (answer.kind) {
      case 'home':
        this.#failures = 0;
        return this.#show({ kind: 'home', home: answer.home, unreachable: false });
      case 'notAllowed':
        this.#failures = 0;
        return this.#show({ kind: 'notAllowed', say: answer.say });
      case 'signedOut':
        this.#rest();
        return this.#show({ kind: 'signedOut' });
      case 'failed': {
        this.#failures += 1;
        const state = this.#state;
        // While "not allowed" is showing, that sentence is all there is.
        if (state.kind !== 'home' && state.kind !== 'starting') return;
        // With a home on screen, a bad look or two passes in silence. With
        // none there is nothing else to show: it is said after the first.
        return this.#show({ ...state, unreachable: this.#failures >= (state.kind === 'home' ? FAILED_LOOKS_BEFORE_SAYING : 1) });
      }
    }
  }

  #show(next: LookState): void {
    if (same(next, this.#state)) return;
    this.#state = next;
    this.#deps.onChange(next);
  }
}
