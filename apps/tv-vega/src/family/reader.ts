/**
 * Something to read on a family member's own television, a page at a time —
 * her week, once she has read it herself (packages/contracts/src/
 * familyTelevision.ts `FamilyTvCard.pages`). Pure: family/FamilyReader.tsx
 * draws one page and hands the remote's presses here.
 *
 * The server wrote every page. The television's own are the counter
 * ("2 of 5") and what the remote does: OK or Right goes on, Left goes back,
 * Back closes. Leaving from the last page — by OK on it, or Back while on
 * it — is what says it was read (`read`, a quiet press: nothing is shown in
 * answer). Closing before the end says nothing, and the card stays.
 *
 * No timers: a page stays until a key turns it.
 */
import { FAMILY_TV_PRESSES, type FamilyTvCard, type FamilyTvPress } from '@wick/contracts';

/**
 * The most lines of a page the screen shows. A page is at most 240
 * characters and five lines of the server's own (a day of her week: a line
 * for the day, up to four for what happened) — five or six lines on screen
 * as a rule, nine when every line runs over. Nine lines of 32pt type at 1.3
 * are what fits above the button inside the television's safe area
 * (FamilyReader.tsx), so every page the server can write is shown whole.
 */
export const READER_PAGE_LINES = 9;
/** The line height that goes with it, as a multiple of the type size. */
export const READER_LINE_HEIGHT = 1.3;

/** What is being read. The pages are the card's as they were when it was opened, so a look in the middle changes nothing under the reader. */
export interface Reading {
  readonly cardId: string;
  readonly pages: readonly string[];
  /** Which page is on screen, from 0. */
  readonly page: number;
}

/** Opens a card's pages at the first — or nothing, for a card that brings none. */
export function openReader(card: FamilyTvCard): Reading | undefined {
  if (!card.pages || card.pages.length === 0) return undefined;
  return { cardId: card.id, pages: card.pages, page: 0 };
}

export interface ReaderPage {
  readonly text: string;
  /** "2 of 5" — absent when there is only the one page. */
  readonly counter?: string;
  readonly last: boolean;
}

export function readerPage(reading: Reading): ReaderPage {
  const count = reading.pages.length;
  return {
    text: reading.pages[reading.page] ?? '',
    ...(count > 1 ? { counter: `${reading.page + 1} of ${count}` } : {}),
    last: reading.page >= count - 1,
  };
}

export type ReaderKey = 'next' | 'previous' | 'back';

/**
 * What a key does. `reading` is what is read next; without it the reader
 * is closed. `press` is what to tell the server, and only ever that the
 * last page was reached.
 */
export interface Turned {
  readonly reading?: Reading;
  readonly press?: FamilyTvPress;
}

export function turn(reading: Reading, key: ReaderKey): Turned {
  const last = reading.page >= reading.pages.length - 1;
  const read: Turned = { press: { cardId: reading.cardId, action: FAMILY_TV_PRESSES.read } };
  switch (key) {
    case 'next':
      return last ? read : { reading: { ...reading, page: reading.page + 1 } };
    case 'previous':
      return { reading: reading.page > 0 ? { ...reading, page: reading.page - 1 } : reading };
    case 'back':
      return last ? read : {};
  }
}

/** kepler's HWEvent: 0 is key down, 1 is key up. */
const KEY_DOWN = 0;

/**
 * Right and Left, from the remote's own events. OK is not here: the page has
 * the focus, and OK is its press (FamilyReader.tsx) — heard once, on both
 * televisions. Acted on as the key goes down, like every other key in Wick
 * (watch/remoteKeys.ts).
 */
export function readerKey(event: { readonly eventType: string; readonly eventKeyAction?: number }): 'next' | 'previous' | undefined {
  if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return undefined;
  if (event.eventType === 'right') return 'next';
  if (event.eventType === 'left') return 'previous';
  return undefined;
}
