/**
 * Which presses of OK count, on a family member's own television. Pure:
 * FamilyApp.tsx tells it what is on screen and what the remote does, and
 * asks it before anything is sent.
 *
 * Two accidents, one cause. A press takes away the thing that had the
 * focus — a card put away, the reader left from its last page — and the
 * television hands the focus to whatever is left or comes next. A second
 * press, meant for the first thing or simply made twice, then lands on
 * something nobody has looked at:
 *
 *   - the wave button, and a wave goes to her television (seen on the Fire
 *     OS emulator, 2026-10-13: "Not now", OK again half a second later);
 *   - the next card's first button — "I'm ringing you now", unread.
 *
 * Where the focus goes is the platform's to decide, and it differs between
 * the two televisions and between versions of each. So neither rule here
 * looks at where the focus was put. They look at what the member did.
 *
 * THE WAVE acts only on a press that was aimed at it: one made after an
 * arrow key, which is how a person gets to it — the home screen gives the
 * focus to something that does nothing (FamilyHome.tsx), and the wave is a
 * D-pad move away. Focus that was handed to it, by anything, is not aim.
 * An arrow counts from the moment the home is on screen with nothing in
 * front; whatever was pressed on a card before does not. A press that is
 * swallowed changes nothing: only an arrow arms the next.
 *
 * A CARD'S BUTTONS — and the sentence that answers a press, and the reader
 * when it opens — do not act for PRESS_SETTLE_MS after they come on screen.
 * A press in that time began, in the member's mind, before there was
 * anything there to read. It is the rule the resident's television keeps
 * for her cards, and the very same code (press/settle.ts): an interval,
 * counted from when the thing to press changed, and again from when Wick
 * comes back on screen.
 *
 * Nothing here is a countdown anyone sees: nothing is shown, hidden or sent
 * by a timer. A press too soon simply does nothing, and the next one works.
 */
import { PRESS_SETTLE_MS, pressSettle } from '../press/settle.js';
import type { Showing } from './familyScreen.js';
import type { Reading } from './reader.js';

/** How long a card's buttons take no press after the card comes on screen (press/settle.ts): one rule, on both televisions. */
export { PRESS_SETTLE_MS };

/**
 * How close an arrow key and the focus arriving on the wave must be to be
 * one move. The two reach the app a moment apart and in no promised order:
 * Vega says the key and then moves the focus; Fire OS moves the focus as
 * the key goes down and says the key as it comes up.
 */
export const ARROW_FOCUS_GRACE_MS = 600;

/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;
const ARROWS: readonly string[] = ['up', 'down', 'left', 'right'];

export interface RemoteKey {
  readonly eventType: string;
  readonly eventKeyAction?: number;
}

export interface PressGuard {
  /**
   * What there is to press, by name (`surfaceOf`). Said on every draw; it
   * counts only when the name changes.
   */
  surface(name: string, now: number): void;
  /** Wick has come back on screen. Whatever is there is new to whoever is looking, and the focus is wherever the platform left it. */
  returned(now: number): void;
  /** Every key the remote sends, as it arrives. Only the arrows matter here. */
  key(event: RemoteKey, now: number): void;
  /** The focus has arrived on the wave. */
  waveFocused(now: number): void;
  /** The focus has left the wave. */
  waveBlurred(): void;
  /** Whether a press on a card's button — or the sentence's, or the reader's — is acted on. */
  cardActs(now: number): boolean;
  /** Whether a press on the wave is acted on. */
  waveActs(now: number): boolean;
}

export function pressGuard(): PressGuard {
  let surface: string | undefined;
  /** The card's first second, as on the resident's television. */
  const settle = pressSettle();
  /** When the member last pressed an arrow, since what is on screen last changed. */
  let arrowAt: number | null = null;
  /** Whether the wave has been aimed at. */
  let aimed = false;

  /** Whatever was pressed before is not aim at what is there now. */
  const disarm = (): void => {
    arrowAt = null;
    aimed = false;
  };

  return {
    surface(name, now) {
      settle.appeared(name, now);
      if (name === surface) return;
      surface = name;
      disarm();
    },
    returned(now) {
      settle.returned(now);
      disarm();
    },
    key(event, now) {
      if (!ARROWS.includes(event.eventType)) return;
      // The key going down is the move; a remote that does not say which half it is, is saying the whole press.
      if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return;
      arrowAt = now;
      aimed = true;
    },
    waveFocused(now) {
      // Brought here by an arrow just pressed: aim. Otherwise the focus was handed over, and that is not.
      if (arrowAt === null || now - arrowAt > ARROW_FOCUS_GRACE_MS) aimed = false;
    },
    waveBlurred() {
      aimed = false;
    },
    cardActs(now) {
      return settle.acts(now);
    },
    waveActs() {
      return aimed;
    },
  };
}

/**
 * The name of what there is to press: the seat, the reader (the same from
 * page to page), the card or the sentence in front (the same from look to
 * look, while its buttons are), or the home with nothing in front.
 */
export function surfaceOf(on: { readonly seated: boolean; readonly reading: Reading | undefined; readonly shown: Showing }): string {
  if (on.seated) return 'seat';
  if (on.reading) return `reader:${on.reading.cardId}`;
  return on.shown.kind === 'nothing' ? 'home' : on.shown.key;
}
