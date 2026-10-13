/**
 * Holding OK for two seconds (packages/contracts/src/reach.ts): the one
 * gesture that brings the card offering to ask someone to ring her.
 *
 * While a programme plays nothing on screen has the remote's focus, so the
 * hold is told from the key events themselves: OK going down starts two
 * seconds, and OK coming up before they are over was a press. On the home
 * screen the focused tile does the same with the platform's own long press
 * (home/HomeScreen.tsx), using the same two seconds.
 *
 * It errs towards not being a hold. Another key pressed meanwhile ends it;
 * so does a card arriving, because then OK belongs to the card; and a
 * remote that never says a key has come up cannot hold at all — a hold
 * that was only guessed would put a question about ringing the family on
 * screen at every press.
 *
 * No React here: WatchScreen.tsx hands it every remote event.
 */
import type { RemoteEventLike } from './remoteKeys.js';

/** Two seconds: long enough that a press, or a thumb resting on the button, never is one. */
export const HOLD_MS = 2_000;

/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;
const KEY_UP = 1;

/** OK, by the name the SDK documents and the one the Vega Virtual Device sends (FRICTION.md FL-021). */
const OK_KEYS: readonly string[] = ['select', 'enter'];

export const isOkKey = (eventType: string): boolean => OK_KEYS.includes(eventType);

export interface OkHold {
  onEvent(event: RemoteEventLike): void;
  /** Whether the press now under way has become a hold: its release is then not a press. */
  held(): boolean;
  cancel(): void;
}

export function okHold(input: {
  readonly onHold: () => void;
  /** OK came up after a hold — not after a press. */
  readonly onRelease?: (() => void) | undefined;
  /** Whether OK is free to be held: not while a card, or the door camera, has the remote. */
  readonly canHold: () => boolean;
}): OkHold {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isDown = false;
  let becameHold = false;

  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  return {
    onEvent(event) {
      if (!isOkKey(event.eventType)) {
        // Another key: whatever she is doing, it is not holding OK.
        if (event.eventKeyAction === KEY_DOWN) stop();
        return;
      }
      if (event.eventKeyAction === KEY_UP) {
        stop();
        const wasHold = becameHold;
        isDown = false;
        becameHold = false;
        if (wasHold) input.onRelease?.();
        return;
      }
      // No halves given: there is no telling a hold from a press, so there is no hold.
      if (event.eventKeyAction !== KEY_DOWN) return;
      // A held key repeats "down"; the two seconds run from the first.
      if (isDown) return;
      isDown = true;
      if (!input.canHold()) return;
      timer = setTimeout(() => {
        timer = undefined;
        // A card may have come in the meantime: then OK is the card's.
        if (!input.canHold()) return;
        becameHold = true;
        input.onHold();
      }, HOLD_MS);
    },
    held: () => becameHold,
    cancel() {
      stop();
      isDown = false;
      becameHold = false;
    },
  };
}
