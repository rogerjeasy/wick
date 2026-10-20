/**
 * How a step of the tour sits on the 960x540dp screen (tour/TourScreen.tsx)
 * — pure, and held by tour/__tests__/tourLayout.test.ts.
 *
 * From the top: the example, drawn as the real thing is drawn, with two
 * tags on its top edge ("How Wick works · 1 of 5" and "Example"); or, for a
 * step whose example is not a card, the kicker and the step's headline;
 * then why, in a sentence or two; then the two buttons. Every word whole,
 * at the floor: where a step would not fit at larger text it is drawn at
 * the standard size, as a card is (vega-calm-ui fitCard) — whole at 32pt
 * beats cut at 40.
 */
import { calmTheme, estimatedLines, layout, type CalmTheme } from '@wick/vega-calm-ui';
import type { TourKind } from './tour.js';

/** The screen, inside the television's safe area. */
export const TOUR_SCREEN = { width: 960, height: 540, paddingHorizontal: 48, paddingVertical: 32 } as const;
export const TOUR_ROW_DP = TOUR_SCREEN.width - 2 * TOUR_SCREEN.paddingHorizontal;
/** Between the blocks of a step. */
export const TOUR_GAP_DP = 8;
/** Between the kicker or headline and what follows it. */
export const TOUR_TEXT_GAP_DP = 8;
/** The door's picture, as DoorCard.tsx reserves it: 16:9, beside the words. */
export const TOUR_FRAME = { width: 256, height: 144 } as const;
/** Around a tag's words. */
export const TAG_PADDING = { horizontal: 12, vertical: 2 } as const;
/** The bars drawn as examples (the hold line, the read chip): their padding. */
export const BAR_PADDING = { horizontal: 24, vertical: 16 } as const;
const MEDIA_GAP_DP = 24;
const BUTTON_PADDING_V_DP = 20;

/** The words of a step, as it says them. */
export interface TourWords {
  readonly headline: string;
  readonly example?: string | undefined;
  readonly detail: string;
}

/** Whether a step's example is a card's face, with the step's headline on it. */
export const exampleIsCard = (kind: TourKind): boolean => kind === 'door' || kind === 'note';

/** A tag on the example's top edge: its height, half of it above the edge. */
export const tagHeightDp = (theme: CalmTheme): number => theme.lineHeight('body') + 2 * TAG_PADDING.vertical;

/**
 * The room above an example's words: its own padding, or — where that is
 * less — enough that the tags on its top edge never lie over its words.
 */
export const exampleTopPaddingDp = (theme: CalmTheme, own: number): number => Math.max(own, tagHeightDp(theme) / 2 + 4);

/** How tall the example is: the card's face, the bar, or nothing. */
export function exampleHeightDp(theme: CalmTheme, kind: TourKind, words: TourWords): number {
  const body = theme.lineHeight('body');
  const edge = 2 * theme.cardEdgeDp;
  if (kind === 'door') {
    // DoorCard's layout: compact, the picture beside the words, the headline at body size.
    const text = TOUR_ROW_DP - 2 * layout.compactPaddingDp - TOUR_FRAME.width - MEDIA_GAP_DP - edge;
    const lines = estimatedLines(words.headline, text, theme.fontSize('body')) * body + layout.compactTextGapDp + estimatedLines(words.example, text, theme.fontSize('body')) * body;
    return exampleTopPaddingDp(theme, layout.compactPaddingDp) + layout.compactPaddingDp + Math.max(TOUR_FRAME.height, lines) + edge;
  }
  if (kind === 'note') {
    // MessageCard's: a CalmCard, the headline at headline size, the note under it.
    const text = TOUR_ROW_DP - 2 * layout.cardPaddingDp - edge;
    return exampleTopPaddingDp(theme, layout.cardPaddingDp) + layout.cardPaddingDp + estimatedLines(words.headline, text, theme.fontSize('headline')) * theme.lineHeight('headline') + layout.textGapDp + estimatedLines(words.example, text, theme.fontSize('body')) * body + edge;
  }
  // The hold line: its words and its line; the read chip: its icon and words.
  const bar = exampleTopPaddingDp(theme, BAR_PADDING.vertical) + BAR_PADDING.vertical + edge;
  if (kind === 'hold') return bar + body + 12 + 8;
  if (kind === 'read') return bar + body;
  return 0;
}

/** The whole height of a step as drawn. */
export function tourHeightDp(theme: CalmTheme, kind: TourKind, words: TourWords): number {
  const body = theme.lineHeight('body');
  const example = exampleHeightDp(theme, kind, words);
  // Above the example, half a tag; with no example, the kicker on a line of its own.
  const top = example > 0 ? tagHeightDp(theme) / 2 + example + TOUR_GAP_DP : body + TOUR_TEXT_GAP_DP;
  const headline = exampleIsCard(kind) ? 0 : estimatedLines(words.headline, TOUR_ROW_DP, theme.fontSize('headline')) * theme.lineHeight('headline') + TOUR_TEXT_GAP_DP;
  const detail = estimatedLines(words.detail, TOUR_ROW_DP, theme.fontSize('body')) * body;
  const buttons = 2 * BUTTON_PADDING_V_DP + body + 2 * theme.ring().footprintDp;
  return top + headline + detail + TOUR_GAP_DP + buttons;
}

/** The room a step has. */
export const TOUR_ROOM_DP = TOUR_SCREEN.height - 2 * TOUR_SCREEN.paddingVertical;

/** The theme to draw a step in: the one she chose, or — where its words would not all fit at larger text — the same at the standard size. */
export function tourTheme(theme: CalmTheme, kind: TourKind, words: TourWords): CalmTheme {
  if (tourHeightDp(theme, kind, words) <= TOUR_ROOM_DP || !theme.preferences.largerText) return theme;
  return calmTheme({ ...theme.preferences, largerText: false });
}
