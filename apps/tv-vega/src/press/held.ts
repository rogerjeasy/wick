/**
 * A press acts only if its key went down on the thing pressed.
 *
 * A television gives a key coming up to whatever has the focus, and that
 * item takes it for a press — whether or not it ever saw the key go down.
 * So OK held down in a film, across Back, and let go seconds later on the
 * home screen started the film that had the focus there (seen on the Fire
 * OS emulator, main e67b1fe). The home's first second (settle.ts) only
 * covers a key let go within it.
 *
 * The rule has two halves, because the two televisions tell an app about a
 * key in two ways, and neither way is enough by itself:
 *
 *   - The focused item is told when OK goes down on it — the platform's
 *     press-in. A press must begin there: an item that was not told the key
 *     went down on it does nothing when the key comes up, however late.
 *     This is the half that holds on Fire OS, where the app itself hears
 *     nothing of a key until it comes up (FRICTION.md FL-028) and press-in
 *     is sent for the first going down only, never for a key already held.
 *   - The app hears keys too (`okHeld`), and where it heard OK go down
 *     before the home came back, it waits for that key to come up — the
 *     pattern the guard for the hold uses (home/reach.ts). Until then
 *     nothing begins a press, whatever the item is told. This is the half
 *     for Vega, which says a held key is "down" again and again and might
 *     say so to an item that has only just been given the focus.
 *
 * When a press that began here is acted on is still one rule, `pressActs`
 * (settle.ts): not in the home's first second back within reach.
 *
 * One kind of press has no key at all. The platform can press an item by
 * its "click", which is how something that is not the remote — a screen
 * reader — presses what has the focus. No key came up, so none can have
 * been held from elsewhere, and there is no beginning to ask for: that
 * press is judged by the home's first second alone, as every press was
 * before. The item knows which it is because the platform says "the key
 * came up" and then, at once, "pressed".
 *
 * Only presses. The D-pad moves the focus as it always did, and OK held for
 * two seconds on the home screen is still the hold — that is the platform's
 * own long press, counted from the same press-in, and nothing here touches
 * it.
 *
 * Pure: `now` is passed in, and the keys are given as they arrive.
 */
import { HOLD_SHOWN_FROM_MS, isOkKey } from '../watch/hold.js';
import type { RemoteEventLike } from '../watch/remoteKeys.js';
import { pressActs } from './settle.js';

/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;

/**
 * OK goes down on an item of the home screen. The moment the press began,
 * if it is one: the home is within the remote's reach, and the key was not
 * already down — as far as the app heard — when the home came back.
 */
export function pressBegins(at: {
  /** When the home came within the remote's reach; null while it is out of it (home/focusMemory.ts). */
  readonly reachableSince: number | null;
  readonly now: number;
  /** Since when OK has been down, as the app heard it (`okHeld`); null when it is up, or was never heard going down. */
  readonly okDownSince: number | null;
}): number | null {
  if (at.reachableSince === null || at.now < at.reachableSince) return null;
  // Down since before the home came back: it is waiting to come up, and it is not a press on anything here.
  if (at.okDownSince !== null && at.okDownSince < at.reachableSince) return null;
  return at.now;
}

/**
 * An item of the home screen is pressed. Whether that is acted on: the
 * home's first second is over — and, when it is a key coming up
 * (`keyCameUp`), the press began here, since the home last came back.
 */
export function pressEnds(at: {
  /** The platform said OK came up on the item just before it said "pressed". False for a press with no key: its click. */
  readonly keyCameUp: boolean;
  readonly reachableSince: number | null;
  /** When the press began on the item (`pressBegins`), or null. */
  readonly beganAt: number | null;
  readonly now: number;
}): boolean {
  if (at.reachableSince === null) return false;
  if (at.keyCameUp && (at.beganAt === null || at.beganAt < at.reachableSince)) return false;
  // Held long enough for the hold line to show (press/HoldLine.tsx), and let go before the two seconds: she was
  // holding, not pressing, and let go — nothing happens at all (docs/design/DESIGN.md §6).
  if (at.keyCameUp && at.beganAt !== null && at.now - at.beganAt >= HOLD_SHOWN_FROM_MS) return false;
  return pressActs(at.reachableSince, at.now);
}

export interface OkHeld {
  /** A key event, as the app hears it. */
  seen(event: RemoteEventLike, now: number): void;
  /** Since when OK has been down; null when it is up, or was never heard going down. */
  since(): number | null;
  /** Wick has gone behind another app: where the key comes up is no longer Wick's to hear. */
  forget(): void;
}

/**
 * What the app hears of OK, whatever is on screen: since when it has been
 * down. A held key says "down" again and again; it is down from the first.
 * If a key is never heard coming up, the next one that is puts it right —
 * at most one press is lost, and none is ever made that she did not make.
 */
export function okHeld(): OkHeld {
  let downSince: number | null = null;
  return {
    seen(event, now) {
      if (!isOkKey(event.eventType)) return;
      if (event.eventKeyAction === KEY_DOWN) {
        if (downSince === null) downSince = now;
        return;
      }
      // The key coming up — or a press that arrives whole, which is over as it arrives.
      downSince = null;
    },
    since: () => downSince,
    forget() {
      downSince = null;
    },
  };
}
