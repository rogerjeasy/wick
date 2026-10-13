/**
 * The mantelpiece — pictures the family sends, and what she chooses to keep.
 *
 * Someone in the family circle sends a picture from the family app. It
 * reaches the resident's television as a card at a quiet moment, like any
 * note (INV-5), with two answers that both put it away: "Keep it" and
 * "Thank you". What she keeps lives on her mantelpiece: opened from the
 * home screen, one picture at a time, each of which she can take down with
 * one press; and when the home screen has sat untouched for a few minutes,
 * her kept pictures fill it slowly until any key is pressed.
 *
 * THE RULE. What she keeps is hers, and so is what she does not.
 *
 *   - The family is told one thing, whichever she pressed: that she has
 *     seen it (photoSeenText). Kept, not kept and taken down a week later
 *     must look exactly the same from outside — otherwise "Thank you"
 *     would say "I did not want it", and taking one down would be a message
 *     (the reasoning of INV-10). Nothing counts her mantelpiece for anyone
 *     but her own home screen.
 *   - A picture's address is minted for her television when it asks, lives
 *     an hour (MANTEL_URL_TTL_SEC), and is written nowhere: not in the
 *     stored card, not in the home message, not on the bus. Rows and cards
 *     carry the picture's id; the object is `photos/<household>/<id>.jpg`,
 *     the household being the sender's own from their token (INV-8).
 *   - A picture carries no words of the family's. A note is the place for
 *     words; the card's own are Wick's (photoCardWords).
 *   - A neighbour sends nothing (circle.ts): a picture is for the family.
 *   - The idle screen makes nothing disappear and interrupts nothing: it is
 *     only there when no card is waiting and nothing is playing, and any
 *     key brings the home screen back.
 *
 * Rows, under `HH#<household>`:
 *   `PHOTO#<photoId>`   every picture sent: who sent it, when, and — once
 *                       she has pressed either button — that it was seen.
 *                       This is all a family tool ever reads.
 *   `MANTEL#<photoId>`  what is on her mantelpiece now. Read only for her
 *                       own televisions. It falls inside the home screen's
 *                       one query (`LIGHT`..`META`).
 */
import type { CardAction } from './card.js';

export const PHOTO_SK_PREFIX = 'PHOTO#';
export const MANTEL_SK_PREFIX = 'MANTEL#';

/** How many things a mantelpiece holds. She takes one down to keep another: nothing leaves it by itself. */
export const MAX_MANTEL = 12;

/** The largest picture taken in: the family app scales and re-encodes before it sends (which also drops where it was taken). */
export const MAX_PHOTO_BYTES = 1_500_000;
/** The longest side the family app scales a picture to: a television's worth, and no more. */
export const PHOTO_MAX_EDGE_PX = 1920;
/** How many pictures one member can send in a day. A mantelpiece is not a feed. */
export const MAX_PHOTOS_A_DAY = 6;

/** How long an address minted for her television is good for. */
export const MANTEL_URL_TTL_SEC = 3600;
/** How long the home screen sits untouched before her pictures fill it. */
export const MANTEL_IDLE_AFTER_MS = 3 * 60_000;
/** How long each picture stays before the next. */
export const MANTEL_EACH_FOR_MS = 20_000;

const PHOTO_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isPhotoId = (value: unknown): value is string => typeof value === 'string' && PHOTO_ID.test(value);

const CARD_PREFIX = 'photo-';
/** Deterministic, like the Circle card's: the press names the picture without the television holding anything. */
export const photoCardId = (photoId: string): string => `${CARD_PREFIX}${photoId}`;

export function photoIdOfCardId(cardId: unknown): string | undefined {
  if (typeof cardId !== 'string' || !cardId.startsWith(CARD_PREFIX)) return undefined;
  const photoId = cardId.slice(CARD_PREFIX.length);
  return isPhotoId(photoId) ? photoId : undefined;
}

/** Where a picture's bytes are. Built only from a verified household and an id Wick made. */
export const photoObjectKey = (householdId: string, photoId: string): string => `photos/${householdId}/${photoId}.jpg`;

/**
 * The one tag on a picture's object, which the bucket's lifecycle goes by
 * (infra/photos.tf): `sent` while she has not answered, `kept` while it is
 * on her mantelpiece — never expired — and `gone` once she has let it go,
 * which the bucket then deletes within a day. An object with no tag would
 * never be let go of: it is always uploaded as `sent`. The tag is read by
 * the bucket and by nothing that answers the family.
 */
export const PHOTO_STATE_TAG = 'state';
export const PHOTO_STATES = { sent: 'sent', kept: 'kept', gone: 'gone' } as const;

/** What can be pressed on the card. Both put it away; one also keeps it. */
export const PHOTO_ACTIONS = { keep: 'keep', thanks: 'thanks' } as const;

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || name;

/** The card's words: Wick's own, under the name of the member she allowed. Never the sender's. */
export function photoCardWords(fromName: string): { readonly headline: string; readonly actions: readonly CardAction[] } {
  return {
    headline: `A picture from ${firstName(fromName)}.`,
    actions: [
      { id: PHOTO_ACTIONS.keep, label: 'Keep it', kind: 'primary' },
      { id: PHOTO_ACTIONS.thanks, label: 'Thank you', kind: 'secondary' },
    ],
  };
}

/** Said on the card when she presses "Keep it" and there is no room. The card stays. */
export const MANTEL_FULL_NOTICE = 'Your mantelpiece is full. Take one down, then you can keep this.';

/** The one thing the family is told, whichever button she pressed. */
export const photoSeenText = (residentName: string): string => `${residentName} has seen your picture.`;

/** A JPEG by its bytes — start of image, a marker, and end of image — whatever the request called it. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}

/** One thing on her mantelpiece, as her television is handed it when it asks. */
export interface MantelItem {
  readonly photoId: string;
  /** The first name of who sent it. */
  readonly fromName: string;
  readonly keptAt: number;
  /** Minted for this asking; good for MANTEL_URL_TTL_SEC. */
  readonly url: string;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The mantelpiece from something that is not this code. What is well formed is kept, in order, up to MAX_MANTEL. */
export function readMantelItems(value: unknown): MantelItem[] {
  if (!Array.isArray(value)) return [];
  const items: MantelItem[] = [];
  for (const raw of value as unknown[]) {
    if (items.length >= MAX_MANTEL) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const { photoId, fromName, keptAt, url } = raw as Record<string, unknown>;
    if (!isPhotoId(photoId) || typeof fromName !== 'string' || !fromName || !isTime(keptAt)) continue;
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    items.push({ photoId, fromName, keptAt, url });
  }
  return items;
}
