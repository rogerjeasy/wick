/**
 * Hold for Sarah, on her own television (packages/contracts/src/reach.ts):
 * which Reach card is the one her hold brought, which are to be put away
 * unseen, and what Back means on one.
 *
 * The server writes every card and every word; this only decides what is
 * still worth showing — as home/light.ts does for the Light card.
 *
 * Two kinds of Reach card look the same to the renderer and are not the
 * same thing. The offer ("Ask Sarah to ring you?") is the answer to her
 * hold and nothing else: it is never something waiting for a break, so one
 * she is not looking at is put away. What the server says about a request
 * she made ("Sarah has been asked…", "Sarah says: …") is kept like a note:
 * if she had put the card away, it comes back at a natural break.
 *
 * Pure.
 */
import { REACH_ACTIONS, type Card, type QueuedCard } from '@wick/contracts';

const isReach = (queued: QueuedCard): boolean => queued.card.type === 'REACH';

/** Whether a card is the offer: it has the button that asks. */
const isOffer = (card: Card): boolean => card.type === 'REACH' && card.actions.some((action) => action.id === REACH_ACTIONS.ring);

/** The Reach card most lately made. Their ids are moments, so the latest is the greatest. */
export function newestReachCard(cards: readonly QueuedCard[]): QueuedCard | undefined {
  return cards.filter(isReach).sort((a, b) => b.queuedAt - a.queuedAt || b.id.localeCompare(a.id))[0];
}

/**
 * Offers to put away: any that is not the card she has open. An earlier
 * hold she let go of, or one left by a launch that was cut short — an offer
 * to ask the family must never turn up later by itself.
 */
export function reachOffersToPutAway(cards: readonly QueuedCard[], openedId: string | null): string[] {
  return cards.filter((queued) => isOffer(queued.card) && queued.id !== openedId).map((queued) => queued.id);
}

/**
 * What Back means on a Reach card she has open: the way out of an offer,
 * and "All right" to anything else. Either finishes the card — unlike a
 * waiting note, which Back only closes — because a Reach card left half
 * answered would come back at the next break and ask again.
 */
export function backAnswersReach(card: Card | undefined): string | undefined {
  if (card?.type !== 'REACH') return undefined;
  return isOffer(card) ? REACH_ACTIONS.notNow : REACH_ACTIONS.ok;
}

/** How long after a hold its release can still be mistaken for a press. Past it the guard gives up. */
export const HOLD_GUARD_MS = 10_000;
/** A release and the press it made reach this code a moment apart, in either order. */
export const RELEASE_GRACE_MS = 400;

export interface HoldGuard {
  /** OK has just been held long enough to be a hold. */
  held(now: number): void;
  /** OK has come up. */
  released(now: number): void;
  /** Whether a card press at `now` is only her thumb coming up — and if so, it is the one press taken. */
  swallows(now: number): boolean;
}

/**
 * Letting go of the hold must never press the card the hold brought.
 *
 * The card can arrive while OK is still down — a hold of three or four
 * seconds is enough. The television then gives the key coming up to
 * whatever has the focus, and the card's first button takes it as a press:
 * "Yes, ask Sarah", unread. So from the hold until her thumb is known to be
 * up, the first press on a card is taken to be that and nothing happens.
 *
 * The release and the press it makes arrive a moment apart and in no
 * promised order, so a press just after a release is still the thumb. A
 * press later than that is hers. And it gives up after a while: on a remote
 * that never says a key came up, the worst this can cost is one press that
 * has to be made again.
 */
export function holdGuard(): HoldGuard {
  let heldAt: number | null = null;
  let releasedAt: number | null = null;
  return {
    held(now) {
      heldAt = now;
      releasedAt = null;
    },
    released(now) {
      if (heldAt !== null && releasedAt === null) releasedAt = now;
    },
    swallows(now) {
      if (heldAt === null) return false;
      const stillDown = releasedAt === null ? now - heldAt < HOLD_GUARD_MS : now - releasedAt < RELEASE_GRACE_MS;
      // Either way the guard has done its work: the next press is hers.
      if (stillDown || releasedAt === null) heldAt = null;
      return stillDown;
    },
  };
}

