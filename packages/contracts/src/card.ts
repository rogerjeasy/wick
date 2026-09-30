/**
 * Cards — everything the television ever shows.
 *
 * INV-5: there are exactly two urgency classes. Do not add a third. The moment a
 * third exists, the Natural-Break Engine's guarantee stops being checkable.
 *
 * See docs/WICK.md Part 5 (design principles), docs/WICK-TECHNICAL.md §3.4.
 */

export type Urgency = 'DOOR' | 'DEFERRED';

/** At most three. Principle 6. Enforced at construction, not by convention. */
export type CardAction = {
  readonly id: string;
  readonly label: string;
  readonly kind: 'primary' | 'secondary' | 'dismiss';
};

interface CardBase {
  readonly id: string;
  readonly householdId: string;
  readonly correlationId: string;
  readonly createdAt: number;
  /** At most 3. Principle 6. */
  readonly actions: readonly CardAction[];
}

/**
 * Phase 1 carries `line` and (usually) `imageRef`. Phase 2 patches in
 * `description` when the vision model returns. If Phase 2 times out at 2500ms the
 * card simply stays as Phase 1 — which is still useful. See §5.2, §9.1.
 */
export interface DoorCard extends CardBase {
  readonly type: 'DOOR';
  readonly line: string;
  readonly imageRef?: string;
  readonly description?: string;
  readonly match?: import('./door.js').VisitorMatch;
}

/** At most three items. Never four. Principle 6. */
export interface DayCard extends CardBase {
  readonly type: 'DAY';
  readonly greeting: string;
  readonly items: readonly { readonly text: string; readonly factId: string }[];
}

export interface MessageCard extends CardBase {
  readonly type: 'MESSAGE';
  readonly fromName: string;
  readonly fromPhotoRef?: string;
  readonly audioRef?: string;
  readonly transcript?: string;
  /** Agent-drafted, in the resident's own register. Exactly three. */
  readonly suggestedReplies: readonly string[];
}

/**
 * INV-7: the resident sees their week before any family surface can read
 * it. This card is that surface — its `id` is always `week-<isoWeek>`
 * (deterministic, not random, the same way DoorCard's id derives from the
 * Ring event) so route.mjs can recover which week a `seen` action refers
 * to without a lookup. One action only: acknowledging is the whole
 * interaction, and pressing it is what sets WeekNarrative.residentSeenAt.
 */
export interface WeekCard extends CardBase {
  readonly type: 'WEEK';
  readonly isoWeek: string;
  readonly text: string;
}

export type Card = DoorCard | DayCard | MessageCard | WeekCard;

export interface QueuedCard {
  readonly id: string;
  readonly urgency: Urgency;
  readonly card: Card;
  readonly queuedAt: number;
  /** DOOR only. DEFERRED cards never expire — Principle 9, no time limits. */
  readonly expiresAt?: number;
  /** Released at most twice, ever. Then it drops to a passive home-screen row. */
  readonly shownCount: number;
}

/** Phase 2 of the two-phase door card. */
export interface CardPatch {
  readonly cardId: string;
  /** A corrected headline — the frame showed nobody (door agent, index.ts). */
  readonly line?: string;
  readonly description?: string;
  readonly imageRef?: string;
  readonly match?: import('./door.js').VisitorMatch;
}

export const MAX_CARD_ACTIONS = 3;
export const MAX_DAY_ITEMS = 3;
export const MAX_CARD_SHOWS = 2;
/**
 * How long a DOOR card stays live: long enough to get from the sofa to the
 * door, short enough that "someone is at the door" is still true. A stale
 * one is worse than silence. The Door agent stamps it as expiresAt (which
 * egress.ts also makes the CARD# item's DynamoDB ttl); the device falls back
 * to queuedAt + this for cards sent before it did.
 */
export const DOOR_CARD_TTL_MS = 5 * 60 * 1000;
