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
 *
 * The home screen under the card keeps the same second (home/HomeScreen.tsx,
 * `pressActs`): when the card goes, the film that has the focus takes no
 * press until the home has been back within the remote's reach for as
 * long. Otherwise the second OK, kept from answering the next card, would
 * start a film instead — a press meant for a card must not fall through to
 * what is underneath.
 */

/** Longer than two presses meant as one; shorter than reading a sentence. */
export const PRESS_SETTLE_MS = 1_000;

/**
 * Whether a press seen at `now` is acted on, by something that came within
 * the remote's reach at `since` — or is not within it at all (`null`),
 * which takes no press. The whole rule, for whoever keeps the moment
 * themselves: the home screen does, beside its memory of where she was
 * (home/focusMemory.ts), so the two count from one moment.
 */
export function pressActs(since: number | null, now: number): boolean {
  return since !== null && now - since >= PRESS_SETTLE_MS;
}

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
      return pressActs(since, now);
    },
  };
}
