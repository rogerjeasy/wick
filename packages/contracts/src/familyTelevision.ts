/**
 * Sarah's television — Wick on a family member's own television.
 *
 * The same app, connected by a member as *theirs* (edge-device pair-claim
 * with `as: 'family'`). It is the family app with a remote and a big
 * screen: it shows that one member what they may already read and lets
 * them give the answers they may already give — and it is not the
 * resident's television in any sense that matters.
 *
 * Kept apart where it matters:
 *
 *   - Its row is `HH#<household>` / `FTV#<deviceId>`, never `DEV#…`, which
 *     is what makes a television the resident's. So nothing meant for the
 *     resident is ever sent to it, and no press on it counts as hers.
 *   - Its token carries `kind: 'family'` and the member's `userId`. It is
 *     not used on the resident's card channel at all. The television asks
 *     the Wick server, over HTTPS, for its home screen and tells it of a
 *     press (mcp-server familyTelevision.ts); the server answers with the
 *     same gated logic as the family's tools, as that one member, checking
 *     the circle again on every call (INV-9).
 *
 * The television renders and never decides: the server writes every word
 * and every button, as it does for the resident's cards.
 */
import type { CardAction } from './card.js';

export const FAMILY_TV_KIND = 'family';
export const FAMILY_TV_SK_PREFIX = 'FTV#';

/** Where the pairing key's public half is published for the Wick server (edge-device family-television.mjs). */
export const PAIRING_PUBLIC_KEY_ROW = { pk: 'CONFIG#pairing', sk: 'PUBLIC_KEY' } as const;

/** What a family television's token says, beside when it expires. */
export interface FamilyTelevisionClaims {
  readonly deviceId: string;
  readonly householdId: string;
  readonly kind: typeof FAMILY_TV_KIND;
  /** The member who connected it: everything it is shown is theirs to read. */
  readonly userId: string;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Whether verified claims are a family television's. The resident's own token has no kind and no member. */
export function isFamilyTelevisionToken(claims: unknown): claims is FamilyTelevisionClaims {
  if (typeof claims !== 'object' || claims === null) return false;
  const { deviceId, householdId, kind, userId } = claims as Record<string, unknown>;
  return kind === FAMILY_TV_KIND && text(deviceId) && text(householdId) && text(userId);
}

/** What a card on a family television can be about. */
export const FAMILY_TV_CARD_KINDS = ['door_look', 'reach'] as const;
export type FamilyTvCardKind = (typeof FAMILY_TV_CARD_KINDS)[number];

const CARD_PREFIX = 'ftv-';
const REQUEST_ID = /^[A-Za-z0-9_-]+$/;

export function familyTvCardId(kind: FamilyTvCardKind, requestId: string): string {
  return `${CARD_PREFIX}${kind}-${requestId}`;
}

/** What a family television's card is about, from its id — or undefined for any other card. */
export function parseFamilyTvCardId(cardId: unknown): { readonly kind: FamilyTvCardKind; readonly requestId: string } | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const rest = cardId.slice(CARD_PREFIX.length);
  const kind = FAMILY_TV_CARD_KINDS.find((k) => rest.startsWith(`${k}-`));
  if (!kind) return undefined;
  const requestId = rest.slice(kind.length + 1);
  return REQUEST_ID.test(requestId) ? { kind, requestId } : undefined;
}

/**
 * One card on a family television. The server wrote all of it. `actions`
 * are the answers that can be given (never more than three); a card with
 * none only says how something stands.
 */
export interface FamilyTvCard {
  readonly id: string;
  readonly kind: FamilyTvCardKind;
  readonly headline: string;
  readonly detail?: string;
  /** The picture from the door, only while the resident's question is open (INV-3: it is Ring's address, stored nowhere). */
  readonly pictureUrl?: string;
  readonly actions: readonly CardAction[];
}

/** `GET /tv/home`: everything a family television shows. */
export interface FamilyTvHome {
  /** Whose home this television looks towards, by the name the member knows them by. */
  readonly residentName: string;
  /** The first name of the member this television belongs to. */
  readonly memberName: string;
  /**
   * Her light in the window, in one sentence — absent when she keeps the
   * shape of her day to herself. Asking for it is a look, and she is told.
   */
  readonly light?: { readonly lit: boolean; readonly line: string };
  /** What is waiting for this member, most pressing first. */
  readonly cards: readonly FamilyTvCard[];
  /** A demo home: its history is simulated, and the screen says so. */
  readonly simulated?: true;
}

/** `POST /tv/press`: the member's press on one of those cards. */
export interface FamilyTvPress {
  readonly cardId: string;
  readonly action: string;
}

/** What the television says back: one sentence, as it stands. */
export interface FamilyTvPressResult {
  readonly done: boolean;
  readonly say: string;
}

/** How often a family television on screen asks again. A doorstep question lasts five minutes; this keeps it well inside that. */
export const FAMILY_TV_LOOK_EVERY_MS = 8_000;
