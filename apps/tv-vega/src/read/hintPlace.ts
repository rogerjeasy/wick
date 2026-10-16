/**
 * Where the mark of the Play key stands on a card (ReadHint.tsx) — pure,
 * and held by read/__tests__/hint.test.ts.
 *
 * The contract asks for one short line on the card saying the key reads it
 * (packages/contracts/src/speech.ts). At 32pt there is no card with a line
 * to spare once it is at its limit — the ordinary card with five lines of
 * detail, the question about her language with six, the picture card —
 * and nothing is ever set smaller. So the sentence is what the screen
 * reader says, and what is drawn is the key's own mark: the same on every
 * card, in the same place, so it need only be learnt once. It is also the
 * one thing on a card that someone who cannot read it from across the room
 * can still make out — and they are who this is for.
 *
 * The place: the right-hand end of the buttons' row, the one row every card
 * ends with. It is drawn over the card, not laid out in it, so it can never
 * push a button onto another row or a card off the screen; and it is no
 * wider than a button's own padding, so where a card's buttons do run to
 * the edge it lies in the last button's margin and never over its words.
 */
import type { Card } from '@wick/contracts';
import type { CalmTheme } from '@wick/vega-calm-ui';

/** The cards drawn compact — less card around the words — whose padding is 24dp, not 32 (hint.test.ts holds this to the views). */
export const COMPACT_CARDS: readonly Card['type'][] = ['DOOR', 'LANGUAGE', 'PHOTO'];

/** The mark: a triangle, as on the key. No wider than the 34dp between a button's words and its edge. */
export const HINT_MARK = { width: 26, height: 30 } as const;

/** Where the card layer keeps a card from the screen's edges (ResidentApp `cardLayer`, DoorCard `lowerThird`). */
const CARD_FROM_SIDE_DP = 48;
const CARD_FROM_BOTTOM_DP = 32;
/** A card's padding, a button's above and below its words, and its ring at the floor (packages/vega-calm-ui tokens). */
const PADDING_DP = { compact: 24, ordinary: 32 } as const;
const BUTTON_PADDING_DP = 20;
const STANDARD_RING_DP = 2;

/**
 * The height of a card's row of buttons in a theme: 2 x 20 and a line of
 * body type — 32pt at 1.4, or 40pt with larger text on — and, with higher
 * contrast on, the ring's extra room above and below.
 */
export function buttonRowDp(theme: CalmTheme): number {
  return 2 * BUTTON_PADDING_DP + theme.lineHeight('body') + 2 * (theme.ring().footprintDp - STANDARD_RING_DP);
}

/**
 * The mark's distance from the right and the bottom of the screen, for a
 * card of that kind, in the theme it is drawn in. With higher contrast on
 * the card has an edge, and the mark keeps inside it.
 */
export function hintPlace(cardType: Card['type'], theme: CalmTheme): { readonly right: number; readonly bottom: number } {
  const padding = (COMPACT_CARDS.includes(cardType) ? PADDING_DP.compact : PADDING_DP.ordinary) + theme.cardEdgeDp;
  return {
    right: CARD_FROM_SIDE_DP + padding,
    bottom: CARD_FROM_BOTTOM_DP + padding + (buttonRowDp(theme) - HINT_MARK.height) / 2,
  };
}
