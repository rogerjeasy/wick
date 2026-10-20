/**
 * The film's bar: its title, how far it has got, and how long is left
 * (docs/design/DESIGN.md §6).
 *
 * It comes when she asks where she is — ↑ or ↓, a pause, a skip — and goes
 * after four seconds of the film playing. While the film is paused it
 * stays: a paused film with nothing on it says nothing about where it is.
 * It never covers a card: a card has the screen while it is up.
 *
 * Pure, and imports nothing of the platform: WatchScreen.tsx and the
 * browser television (apps/ops-console/tv.js) draw the same bar from the
 * same numbers.
 */
import type { RemoteEventLike } from './remoteKeys.js';

/** How long the bar stays while the film plays, after the last thing that brought it. */
export const TRANSPORT_SHOWN_MS = 4_000;

/** kepler's HWEvent: 0 is key down. */
const KEY_DOWN = 0;

/** ↑ and ↓, by every name the two televisions give them. Over a film they ask where she is. */
const INFO_KEYS: readonly string[] = ['up', 'down', 'dpad_up', 'dpad_down'];

/** Whether a key, over a film, asks for the bar: ↑ or ↓ going down, with no card on screen to take them. */
export function asksWhereFilmIs(event: RemoteEventLike, at: { readonly cardVisible: boolean }): boolean {
  if (at.cardVisible) return false;
  if (event.eventKeyAction !== undefined && event.eventKeyAction !== KEY_DOWN) return false;
  return INFO_KEYS.includes(event.eventType);
}

export interface TransportState {
  /** The film is paused (by her, or held by a card that has since gone). */
  readonly paused: boolean;
  /** A card is on screen: the bar never covers one. */
  readonly cardVisible: boolean;
  /** The film is still opening, or will not play: there is nothing to say where it is. */
  readonly ready: boolean;
  /** When she last asked where she is — ↑, ↓, a skip, a pause — or null for never. */
  readonly askedAt: number | null;
  readonly now: number;
}

/** Whether the bar is on screen now. */
export function transportShown(state: TransportState): boolean {
  if (state.cardVisible || !state.ready) return false;
  if (state.paused) return true;
  return state.askedAt !== null && state.now - state.askedAt < TRANSPORT_SHOWN_MS;
}

/** A time on the bar: "4:05", or "1:02:09" past the hour. Never negative, never a fraction of a second. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** How far the film has got, from 0 to 1, for the progress line. 0 for a film with no length yet. */
export function fraction(positionMs: number, durationMs: number): number {
  if (!(durationMs > 0) || !Number.isFinite(positionMs)) return 0;
  return Math.min(1, Math.max(0, positionMs / durationMs));
}

/** Whole minutes left, rounded up, and never less than one while any of the film is left: "1 min left", not "0". */
export function minutesLeft(positionMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 0;
  const left = Math.max(0, durationMs - Math.max(0, positionMs));
  return left === 0 ? 0 : Math.max(1, Math.ceil(left / 60_000));
}
