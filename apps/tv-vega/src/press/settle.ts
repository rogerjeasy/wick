/**
 * A card's buttons take no press in the card's first second on screen.
 *
 * The same rule on both televisions — the resident's (ResidentApp.tsx) and
 * a family member's own (family/presses.ts) — kept here, where both may
 * read it and neither reaches the other through it. Pure, and it imports
 * nothing.
 *
 * On the resident's television a card is where consent is given: "Allow
 * Sarah", "Tell Sarah", "Start the film", "Yes, ask Sarah", "Yes, that's
 * right". A card comes on screen with its first button focused. When she
 * answers one card and the next is released a moment later, a second OK —
 * a double press, a remote key that bounced, a press begun before she
 * could have read a word — would answer a question she has not seen. So a
 * press seen in a card's first PRESS_SETTLE_MS does nothing: nothing is
 * sent, nothing is removed, nothing is said. The next press works, and the
 * second is counted from the card, not from her last press — pressing
 * early never makes the wait longer.
 *
 * "Came on screen" means a different card: by its id. The same card drawn
 * again — a tick, a patch, the door's picture arriving, a page of "What
 * Sarah sees" replaced under the same card — is the same card, and its
 * buttons stay live. A card that left and came back has come on screen
 * again. So has whatever is there when Wick returns from the background:
 * she is looking at it afresh.
 *
 * It is an interval because the remote cannot be asked when a press began:
 * on Fire OS a short press reaches the app only as the key coming up
 * (FRICTION.md FL-028). What is compared is when the press is SEEN with
 * when the card appeared. It is about presses only — the D-pad moves the
 * focus as it always did — and nothing is shown, hidden or sent by it.
 */

/** Longer than two presses meant as one; shorter than reading a sentence. */
export const PRESS_SETTLE_MS = 1_000;

export interface PressSettle {
  /**
   * What is on screen to be pressed, by name — a card's id — or null for
   * nothing. Said every time the screen is drawn; it counts only when the
   * name changes.
   */
  appeared(what: string | null, now: number): void;
  /** Wick has come back on screen. Whatever is there starts its second again. */
  returned(now: number): void;
  /** Whether a press seen at `now` is acted on. */
  acts(now: number): boolean;
}

export function pressSettle(): PressSettle {
  let showing: string | null | undefined;
  let since = Number.NEGATIVE_INFINITY;
  return {
    appeared(what, now) {
      if (what === showing) return;
      showing = what;
      since = now;
    },
    returned(now) {
      since = now;
    },
    acts(now) {
      return now - since >= PRESS_SETTLE_MS;
    },
  };
}
