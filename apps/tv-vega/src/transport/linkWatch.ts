/**
 * Whether the television should say that it cannot reach home.
 *
 * The channel reconnects by itself, and a connection drops for a second or
 * two all the time — a router's hiccup, a token renewed. A line on her
 * screen for each of those would be a nag, and a line that never came
 * would leave her trusting a door that is not listening. So the channel's
 * state is reported here every second, and the answer is "down" only once
 * it has been unbroken for `downAfterMs`. One second of open puts it right.
 *
 * Pure: the clock is given.
 */
export const LINK_DOWN_AFTER_MS = 20_000;

export interface LinkWatch {
  /** Reports whether the channel is open now; says whether to tell her it is down. */
  report(open: boolean, now: number): boolean;
  /** A new channel is being made: whatever trouble the last one was in is not this one's. */
  reset(): void;
}

export function linkWatch(downAfterMs: number = LINK_DOWN_AFTER_MS): LinkWatch {
  let troubleSince: number | undefined;
  return {
    report(open, now) {
      if (open) {
        troubleSince = undefined;
        return false;
      }
      troubleSince ??= now;
      return now - troubleSince >= downAfterMs;
    },
    reset() {
      troubleSince = undefined;
    },
  };
}
