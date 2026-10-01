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
  /** One plain sentence about something the resident just did (M1: whether the chime rang). */
  readonly notice?: string;
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

/**
 * "What Sarah sees" — trust promise 2 on the resident's own screen. One
 * thing the family can see per card, in plain words, with one button to
 * keep it private or share it again. The server builds every page from the
 * live household policy; the television only renders it. Its id is always
 * `sharing`, so each press replaces the card in place.
 */
export interface SharingCard extends CardBase {
  readonly type: 'SHARING';
  /** The policy class this page controls. */
  readonly factClass: import('./fact.js').FactClass;
  readonly page: number;
  readonly pages: number;
  readonly headline: string;
  readonly detail: string;
}

export type Card = DoorCard | DayCard | MessageCard | WeekCard | SharingCard;

export interface QueuedCard {
  readonly id: string;
  readonly urgency: Urgency;
  readonly card: Card;
  readonly queuedAt: number;
  /** DOOR only. DEFERRED cards never expire — Principle 9, no time limits. */
  readonly expiresAt?: number;
  /** Released at most twice, ever. Then it drops to a passive home-screen row. */
  readonly shownCount: number;
  /**
   * The id of the card whose press opened this one ("What Sarah sees" from
   * the Week card). The resident asked for it, so among releasable DEFERRED
   * cards it comes first. Not a third urgency class: it is released by the
   * same rules as every DEFERRED card (INV-5).
   */
  readonly respondsTo?: string;
}

/** Phase 2 of the two-phase door card. */
export interface CardPatch {
  readonly cardId: string;
  /** A corrected headline — the frame showed nobody (door agent, index.ts). */
  readonly line?: string;
  readonly description?: string;
  readonly imageRef?: string;
  readonly match?: import('./door.js').VisitorMatch;
  /** M1 feedback. See DoorCard.notice. */
  readonly notice?: string;
  /** Replaces the card's actions — e.g. without the chime button once it has rung. Capped at MAX_CARD_ACTIONS on merge. */
  readonly actions?: readonly CardAction[];
}

export const MAX_CARD_ACTIONS = 3;

/**
 * The longest text a card's body may carry: five lines of about
 * fifty-eight characters at 32pt on a 960x540dp screen, which is where
 * vega-calm-ui's CalmCard cuts it so the buttons stay on screen. Anything
 * that writes card text keeps under this, so nothing is ever cut.
 */
export const MAX_CARD_DETAIL_CHARS = 240;

/**
 * A DOOR card's action ids. Only `dismiss` removes the card on press:
 * `watch_live` opens the live view over it, and `hallway_chime` waits for
 * the patch that says whether the chime rang.
 */
export const DOOR_ACTIONS = {
  watchLive: 'watch_live',
  hallwayChime: 'hallway_chime',
  dismiss: 'dismiss',
} as const;
/** The Week card's actions. `seen` is the only one that releases the week (INV-7). */
export const WEEK_ACTIONS = {
  seen: 'seen',
  sharing: 'sharing',
} as const;

/** The sharing card's actions. Stable ids: a press re-renders in place, focus stays put. */
export const SHARING_ACTIONS = {
  toggle: 'toggle',
  next: 'next',
  done: 'done',
} as const;

export const SHARING_CARD_ID = 'sharing';

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
