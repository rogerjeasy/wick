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
import { replyActions } from '../cards/messageActions.js';

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

/*
 * The read chip (docs/design/DESIGN.md §5): where a card's buttons leave
 * room at the right-hand end of their row, the mark is the speaker icon
 * and the words "Read aloud" — what Play does, said on the card. Where they
 * do not, it is the icon alone, which stands in the last button's margin as
 * the triangle did, and the screen reader says the sentence. The chip is
 * drawn over the card, never laid out in it, so it can never push a button
 * onto another row or the card off the screen.
 */

/** Around the chip's icon and words. */
export const READ_CHIP = { paddingHorizontal: 12, paddingVertical: 2, iconGapDp: 8, fromButtonsDp: 16 } as const;

/** CalmCard's buttons (packages/vega-calm-ui theme.ts): padding either side of the words, the gap between them, a letter's width. */
const BUTTON_PADDING_H_DP = 32;
const BUTTON_GAP_DP = 16;
/**
 * A letter's width, as the home screen measured it on the Vega Virtual
 * Device (homeLayout.test.ts: 0.47 of the type size). On the simulator the
 * buttons' words came out narrower still — "Keep it to myself" and "Tell
 * Sarah" at about 0.37 — so this errs towards the icon alone by a margin.
 */
const GLYPH_WIDTH_EM = 0.47;

/** The words on a card's buttons, as the card draws them. */
export function actionLabelsOf(card: Card): readonly string[] {
  if (card.type === 'MESSAGE') return replyActions(card.suggestedReplies).map((action) => action.label);
  return card.actions.map((action) => action.label);
}

/** The chip's height: a line of body type and its padding. */
export const readChipHeightDp = (theme: CalmTheme): number => theme.lineHeight('body') + 2 * READ_CHIP.paddingVertical + 2 * theme.cardEdgeDp;

/** The chip's width, with these words. */
export function readChipWidthDp(theme: CalmTheme, words: string): number {
  const icon = theme.preferences.largerText ? 40 : 32;
  return icon + READ_CHIP.iconGapDp + words.length * theme.fontSize('body') * GLYPH_WIDTH_EM + 2 * READ_CHIP.paddingHorizontal + 2 * theme.cardEdgeDp;
}

/**
 * Whether "Read aloud" fits beside a card's buttons: they take one row, and
 * the chip fits after the last of them inside the card. Estimated, and it
 * errs towards the icon alone.
 */
export function readChipFits(theme: CalmTheme, cardType: Card['type'], labels: readonly string[], words: string): boolean {
  const padding = (COMPACT_CARDS.includes(cardType) ? PADDING_DP.compact : PADDING_DP.ordinary) + theme.cardEdgeDp;
  const inner = 960 - 2 * CARD_FROM_SIDE_DP - 2 * padding;
  const ring = 2 * theme.ring().footprintDp;
  const buttons = labels.reduce((sum, label, i) => sum + (i > 0 ? BUTTON_GAP_DP : 0) + label.length * theme.fontSize('body') * GLYPH_WIDTH_EM + 2 * BUTTON_PADDING_H_DP + ring, 0);
  return buttons + READ_CHIP.fromButtonsDp + readChipWidthDp(theme, words) <= inner;
}

/** Where the chip, or the icon alone, stands: at the right-hand end of the buttons' row, centred on it. */
export function readChipPlace(cardType: Card['type'], theme: CalmTheme, heightDp: number): { readonly right: number; readonly bottom: number } {
  const padding = (COMPACT_CARDS.includes(cardType) ? PADDING_DP.compact : PADDING_DP.ordinary) + theme.cardEdgeDp;
  return { right: CARD_FROM_SIDE_DP + padding, bottom: CARD_FROM_BOTTOM_DP + padding + (buttonRowDp(theme) - heightDp) / 2 };
}
