/**
 * Her mantelpiece, on her own television (packages/contracts/src/mantel.ts):
 * the pictures the family sent that she chose to keep, opened from the home
 * screen, one at a time, each of which she can take down with one press.
 *
 * The server says what is on it, and mints each picture's address for the
 * asking; this decides only what the screen does with that: which picture
 * is in view, what OK, the arrows and Back do, when to ask again. Pure, so
 * it is tested without a television; MantelScreen.tsx renders what it says.
 *
 * Three things it is careful about:
 *
 *   - OK does not take a picture down. It opens a choice whose first
 *     button, the one with the focus, is "Leave it" — so a press made
 *     without reading changes nothing. Only the second button names the
 *     picture to the server, once, and what is then shown is the server's
 *     answer: the mantelpiece as it now stands.
 *   - An address lives an hour. What the server answered is used for about
 *     fifty minutes and then asked for again; and a picture that does not
 *     load is asked for again once, with a calm line in its place meanwhile.
 *   - It is a screen she asked for. A note that becomes showable while it
 *     is open waits until she leaves — as it would wait behind the card
 *     about her light. The door never waits (INV-5).
 */
import { MANTEL_URL_TTL_SEC, type HomeState, type MantelItem, type QueuedCard } from '@wick/contracts';
import type { Mantel } from '../headless/QueueStore.js';

/** How long an answer is used before it is asked for again: ten minutes short of how long its addresses live. */
export const MANTEL_FRESH_FOR_MS = MANTEL_URL_TTL_SEC * 1000 - 10 * 60_000;

/** Not asked again sooner than this after asking: an answer is on its way, or the server is not there to give one. */
export const MANTEL_ASK_AGAIN_MS = 60_000;

/** Whether the home screen offers it: only when at least one thing is on it. */
export const offersMantel = (home: HomeState): boolean => (home.mantel ?? 0) >= 1;

export function isFresh(mantel: Mantel | undefined, now: number): mantel is Mantel {
  return mantel !== undefined && now - mantel.receivedAt < MANTEL_FRESH_FOR_MS;
}

/** Whether to ask the server for the mantelpiece now: what is known is missing or old, and it was not asked a moment ago. */
export function shouldAsk(at: { readonly mantel: Mantel | undefined; readonly askedAt: number | null; readonly now: number }): boolean {
  if (isFresh(at.mantel, at.now)) return false;
  return at.askedAt === null || at.now - at.askedAt >= MANTEL_ASK_AGAIN_MS;
}

/**
 * What the screen has to show when she opens it at `openedAt`: the answer
 * to that opening, whatever it says; until it comes, what was answered a
 * little while ago, if that still loads and has anything on it. Otherwise
 * nothing, and the screen waits.
 */
export function mantelToShow(mantel: Mantel | undefined, openedAt: number, now: number): Mantel | undefined {
  if (!mantel) return undefined;
  if (mantel.receivedAt >= openedAt) return mantel;
  return isFresh(mantel, now) && mantel.items.length > 0 ? mantel : undefined;
}

/**
 * A card picked while the mantelpiece is open: the door comes through at
 * once, anything else waits until she leaves the screen she asked for.
 */
export function overMantel(picked: QueuedCard | undefined, mantelOpen: boolean): QueuedCard | undefined {
  if (!mantelOpen || picked?.urgency === 'DOOR') return picked;
  return undefined;
}

export interface Viewer {
  /** The mantelpiece as last answered. Empty until the first answer. */
  readonly items: readonly MantelItem[];
  /** When that answer came; undefined before the first. */
  readonly receivedAt: number | undefined;
  /** Which picture is in view. */
  readonly index: number;
  /** The choice OK opens — "Leave it" / "Take it down" — is on screen. */
  readonly choosing: boolean;
  /** Nothing to look at yet: no answer has come, or she has taken one down and the answer to that has not. */
  readonly waiting: boolean;
  /** The answer for which a picture that would not load has already been asked for again. */
  readonly askedAgainFor: number | undefined;
}

export const VIEWER_START: Viewer = { items: [], receivedAt: undefined, index: 0, choosing: false, waiting: true, askedAgainFor: undefined };

export type ViewerEvent =
  /** What the server last answered, or nothing yet. */
  | { readonly t: 'mantel'; readonly mantel: Mantel | undefined }
  /** Left or Right. */
  | { readonly t: 'move'; readonly by: 1 | -1 }
  /** OK on the picture. */
  | { readonly t: 'ok' }
  /** The choice's first button. */
  | { readonly t: 'leave' }
  /** The choice's second button. */
  | { readonly t: 'take_down' }
  | { readonly t: 'back' }
  /** The picture's address did not answer. */
  | { readonly t: 'failed'; readonly photoId: string };

export type ViewerEffect =
  /** Back to the home screen. */
  | { readonly t: 'close' }
  /** Ask the server for the mantelpiece again. */
  | { readonly t: 'ask' }
  /** Tell the server she took this one down. */
  | { readonly t: 'take_down'; readonly photoId: string };

const NOTHING: readonly ViewerEffect[] = [];
const same = (state: Viewer): { readonly state: Viewer; readonly effects: readonly ViewerEffect[] } => ({ state, effects: NOTHING });

/** The picture in view, if there is one to look at. */
export function inView(state: Viewer): MantelItem | undefined {
  return state.waiting ? undefined : state.items[state.index];
}

/** The one quiet line under it: who it is from, and where it stands — "From Sarah · 2 of 5". */
export function caption(state: Viewer): { readonly fromName: string; readonly place: number; readonly count: number } | undefined {
  const item = inView(state);
  return item && { fromName: item.fromName, place: state.index + 1, count: state.items.length };
}

export function viewer(state: Viewer, event: ViewerEvent): { readonly state: Viewer; readonly effects: readonly ViewerEffect[] } {
  switch (event.t) {
    case 'mantel': {
      const { mantel } = event;
      // Nothing yet, or the answer already taken in.
      if (!mantel || mantel.receivedAt === state.receivedAt) return same(state);
      if (mantel.items.length === 0) {
        return { state: { ...state, items: [], receivedAt: mantel.receivedAt, index: 0, choosing: false, waiting: true }, effects: [{ t: 'close' }] };
      }
      // The picture she was looking at, if it is still there; else whatever now stands in its place.
      const was = state.waiting ? undefined : state.items[state.index]?.photoId;
      const still = was === undefined ? -1 : mantel.items.findIndex((item) => item.photoId === was);
      const index = still >= 0 ? still : Math.min(state.index, mantel.items.length - 1);
      return same({ ...state, items: mantel.items, receivedAt: mantel.receivedAt, index, choosing: state.choosing && still >= 0, waiting: false });
    }

    case 'move': {
      // While the choice is open the arrows are its two buttons'.
      if (state.waiting || state.choosing) return same(state);
      const index = Math.max(0, Math.min(state.items.length - 1, state.index + event.by));
      return index === state.index ? same(state) : same({ ...state, index });
    }

    case 'ok':
      return inView(state) && !state.choosing ? same({ ...state, choosing: true }) : same(state);

    case 'leave':
      return state.choosing ? same({ ...state, choosing: false }) : same(state);

    case 'take_down': {
      const item = inView(state);
      // Only from the choice: nothing else on this screen takes a picture down.
      if (!item || !state.choosing) return same(state);
      return { state: { ...state, choosing: false, waiting: true }, effects: [{ t: 'take_down', photoId: item.photoId }] };
    }

    case 'back':
      return state.choosing ? same({ ...state, choosing: false }) : { state, effects: [{ t: 'close' }] };

    case 'failed':
      // Once for each answer: if the new addresses fail too, asking for ever would not help.
      if (state.receivedAt === undefined || state.askedAgainFor === state.receivedAt) return same(state);
      return { state: { ...state, askedAgainFor: state.receivedAt }, effects: [{ t: 'ask' }] };
  }
}

/**
 * A picture card whose picture cannot be shown: it came with no address, or
 * the address it came with has run out — a card never expires, and may wait
 * on the home screen for days, while an address lives an hour.
 *
 * The server mints a new address each time it sends the card, so the cards
 * are asked for again (the reconcile the channel makes when it connects):
 * the card comes back under its id with an address that answers. Asked once
 * for a card, and not again while that new address would still be good — if
 * the picture cannot be shown with a fresh address, asking for another will
 * not help, and the card says so calmly with its buttons working.
 */
export function pictureRefresher(): { due(cardId: string, now: number): boolean } {
  const askedAt = new Map<string, number>();
  return {
    due(cardId, now) {
      const last = askedAt.get(cardId);
      if (last !== undefined && now - last < MANTEL_FRESH_FOR_MS) return false;
      askedAt.set(cardId, now);
      return true;
    },
  };
}
