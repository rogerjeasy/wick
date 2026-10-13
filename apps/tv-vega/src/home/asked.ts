/**
 * The wait for the answer to something she asked for: her two-second hold
 * on OK, which brings the card that offers to ask someone to ring her
 * (home/reach.ts), and her press on the light, which brings the Light card
 * (home/light.ts). Both are a question sent to the server, and the answer
 * is a card. Both wait for it the same way, which is this.
 *
 * The wait is counted from when the question LEAVES the television, not
 * from her press. The two are a second apart when the channel is open, and
 * can be half a minute apart when it is not — just after a launch, or while
 * it is reconnecting. Counted from the press, an answer to a question that
 * left late was put away as one she had not asked for: she held the button,
 * Wick had an answer for her, and threw it away (seen on the Vega
 * simulator, 2026-10-13). So:
 *
 *   - asked, not yet sent: waiting. An answer that comes is hers.
 *   - sent: waiting for LIGHT_ANSWER_WAIT_MS from then, as before.
 *   - not sent within ASK_SEND_WITHIN_MS of her press: forgotten — and the
 *     question itself is dropped from the outbox rather than sent late
 *     (`worthSending`, used by transport/startCardChannel.ts). The server
 *     answers a question when it arrives, whenever it was asked; an offer
 *     to ask the family that turned up minutes after she pressed, perhaps
 *     in the middle of a film, would be worse than none.
 *
 * Pure. All times are this television's own clock.
 */
import type { DeviceEvent } from '@wick/contracts';
import { answersHerPress } from './light.js';

/** How long after her press a question may still leave the television. Past it, it is not sent at all. */
export const ASK_SEND_WITHIN_MS = 60_000;

export interface Asking {
  /** She asked, at `at`. The question is in the outbox; `at` is the time it carries. */
  asked(at: number): void;
  /** The question she asked at `askedAt` left the television at `at`. One from an earlier ask changes nothing. */
  sent(askedAt: number, at: number): void;
  /** Whether a card arriving now is the answer to what she asked. */
  waiting(now: number): boolean;
  /** She has had her answer, or let it go. */
  done(): void;
}

export function asking(): Asking {
  let askedAt: number | null = null;
  let sentAt: number | null = null;
  return {
    asked(at) {
      askedAt = at;
      sentAt = null;
    },
    sent(of, at) {
      // Only the question now being waited for, only once, and only if it left in time.
      if (askedAt === null || of !== askedAt || sentAt !== null || at - askedAt >= ASK_SEND_WITHIN_MS) return;
      sentAt = at;
    },
    waiting(now) {
      if (askedAt === null) return false;
      if (sentAt !== null) return answersHerPress(sentAt, now);
      return now - askedAt < ASK_SEND_WITHIN_MS;
    },
    done() {
      askedAt = null;
      sentAt = null;
    },
  };
}

/**
 * Whether an event waiting in the outbox should still be sent. Everything
 * is, however old — what she watched, what she answered, what was shown —
 * except a question: her hold, or her press on the light, more than
 * ASK_SEND_WITHIN_MS after she made it.
 */
export function worthSending(event: DeviceEvent, now: number): boolean {
  if (event.t !== 'reach' && event.t !== 'light') return true;
  return now - event.at < ASK_SEND_WITHIN_MS;
}
