/**
 * The home screen behind whatever is over it.
 *
 * The rule: while a card is on screen over the home, nothing of the home
 * screen is partly visible. A card stands at the bottom of the screen and
 * is as tall as its words, so its top edge can fall anywhere — and for a
 * card of a certain height it fell across the title row, slicing the
 * question and the light's pill in half; a shorter card left the tops of
 * the films showing above it.
 *
 * So the home's rows are left out whole while a card shows. The card is
 * alone on the ground colour, and when it goes the rows come back with the
 * focus where it was (HomeScreen keeps that memory itself, and is never
 * taken down for a card). Left out, not covered: a row that is not drawn
 * cannot be focused, and cannot be found or read out by a screen reader
 * either, which a row hidden under a sheet of ground colour still could.
 *
 * Her mantelpiece and her pictures on an idle screen cover the home whole
 * by themselves, so under those the rows stay — drawn, and out of the
 * remote's reach. And for the moment after a key has ended the idle screen
 * the home is in view again while still out of reach (mantel/idle.ts).
 *
 * This is about the home screen only. A film stays in view behind a card,
 * as it always has: the card is drawn over the programme, never instead of
 * it.
 *
 * Pure.
 */
import { blocksHome, type Idle } from '../mantel/idle.js';

export interface HomeBehind {
  /** Whether the home's rows are drawn at all. */
  readonly rows: boolean;
  /** Whether the remote can reach them. Never when they are not drawn. */
  readonly reach: boolean;
}

export function homeBehind(over: {
  /** A card is on screen — or held under the door camera, which she opened from it. */
  readonly card: boolean;
  /** She has her mantelpiece open. */
  readonly mantelOpen: boolean;
  /** The idle screen: off, on, or ending. */
  readonly idle: Idle;
}): HomeBehind {
  const rows = !over.card;
  return { rows, reach: rows && !over.mantelOpen && !blocksHome(over.idle) };
}
