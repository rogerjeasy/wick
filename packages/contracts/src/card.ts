/**
 * Cards — everything the television ever shows.
 *
 * INV-5: there are exactly two urgency classes. Do not add a third. The moment a
 * third exists, the Natural-Break Engine's guarantee stops being checkable.
 *
 * See docs/WICK.md §7 (design principles), docs/WICK-TECHNICAL.md §3.4.
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

/**
 * INV-9 on the resident's own screen: one person who would like to join the
 * family circle, and one press to allow it or not. The server writes every
 * word (services/mcp-server/src/accounts/circle.ts); the television only
 * renders it. Its id is always `circle-<userId>` (circle.ts), so the press
 * names the person without the television holding anything about them.
 */
export interface CircleCard extends CardBase {
  readonly type: 'CIRCLE';
  readonly personName: string;
  readonly role: import('./circle.js').CircleRole;
  readonly headline: string;
  readonly detail: string;
}

/**
 * "Shall I tell Sarah?" — something about today is unlike this household's
 * usual, and the resident decides whether the family hears of it (tell.ts).
 * `detail` is the very sentence the family would be told, so the resident
 * reads exactly what would leave the house. The server writes every word
 * (services/agent rhythm/tell.ts); the television only renders it. Its id is
 * always `tell-<differenceId>` (tell.ts), so the press names what it answers.
 */
export interface TellCard extends CardBase {
  readonly type: 'TELL';
  readonly headline: string;
  readonly detail: string;
}

/**
 * Watch together (watch.ts): one of a session's four cards. The server
 * writes every word and every button; the television only renders it. Its
 * id is `watch-<kind>-<sessionId>` (watchCardId), so a press names the
 * session without the television holding anything about it.
 */
export interface WatchCard extends CardBase {
  readonly type: 'WATCH';
  readonly sessionId: string;
  readonly headline: string;
  readonly detail?: string;
  /** The first name of the family member who would watch along, as the resident knows them. */
  readonly withName: string;
  /**
   * Only on the card whose `start` press opens the film: which film, and
   * the moment after which that press opens it for the resident alone,
   * because nobody is following any more (watch.ts watchWindow).
   */
  readonly programmeId?: string;
  readonly followedUntil?: number;
}

/**
 * The light in the window (light.ts), as the resident sees their own: who
 * can see it, who looked in today, and the one button that puts it out or
 * lights it again. Asked for from the home screen; the server writes every
 * word (edge-device light.mjs). Its id is always `light`.
 */
export interface LightCard extends CardBase {
  readonly type: 'LIGHT';
  readonly headline: string;
  readonly detail: string;
}

/**
 * Hold for Sarah (reach.ts): the card her two-second hold on OK brings, and
 * every later state of the same request — who was asked, who is next, what
 * was answered. The server writes every word; the television only renders
 * it. Its id is always `reach-<reachId>`.
 */
export interface ReachCard extends CardBase {
  readonly type: 'REACH';
  readonly headline: string;
  readonly detail?: string;
}

/**
 * The visit, witnessed (visit.ts): what the door noted of a regular visitor's
 * visit, put to the resident to say whether it is right. The server writes
 * every word; the television only renders it. Its id is always
 * `visit-<arrivedAt>-<personId>`, so the press names the visit.
 */
export interface VisitCard extends CardBase {
  readonly type: 'VISIT';
  readonly headline: string;
  readonly detail: string;
}

/**
 * The television speaks her language (language.ts): the organiser has asked
 * for another, and it is put to the resident in both languages at once. The
 * server writes every word (languageQuestion); the television only renders
 * it. Its id is always `language-<language>`, so the press names the
 * language. It is the one card never passed through the phrasebook.
 */
export interface LanguageCard extends CardBase {
  readonly type: 'LANGUAGE';
  /** The language asked for. */
  readonly language: import('./language.js').HouseholdLanguage;
  readonly headline: string;
  readonly detail: string;
}

/**
 * The mantelpiece (mantel.ts): a picture someone in the family sent. Its
 * words are Wick's own (photoCardWords); the picture carries none of the
 * family's. Its id is always `photo-<photoId>`, so the press names the
 * picture. `photoUrl` is minted for the television on the way out and is
 * never in the stored card: the stored card has the id and nothing else of
 * the picture.
 */
export interface PhotoCard extends CardBase {
  readonly type: 'PHOTO';
  readonly photoId: string;
  readonly fromName: string;
  readonly headline: string;
  /** A short-lived address for this television, absent in every stored copy. */
  readonly photoUrl?: string;
  /** Said under the picture when "Keep it" found the mantelpiece full. */
  readonly notice?: string;
}

export type Card = DoorCard | MessageCard | WeekCard | SharingCard | CircleCard | TellCard | WatchCard | LightCard | ReachCard | VisitCard | LanguageCard | PhotoCard;

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
 * `watch_live` opens the live view over it, `hallway_chime` waits for
 * the patch that says whether the chime rang, and `ask_family` waits for
 * the patch that says who was asked — and then for what they answer.
 */
export const DOOR_ACTIONS = {
  watchLive: 'watch_live',
  hallwayChime: 'hallway_chime',
  askFamily: 'ask_family',
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

export const MAX_CARD_SHOWS = 2;
/**
 * How long a DOOR card stays live: long enough to get from the sofa to the
 * door, short enough that "someone is at the door" is still true. A stale
 * one is worse than silence. The Door agent stamps it as expiresAt (which
 * egress.ts also makes the CARD# item's DynamoDB ttl); the device falls back
 * to queuedAt + this for cards sent before it did.
 */
export const DOOR_CARD_TTL_MS = 5 * 60 * 1000;
