/**
 * Design tokens. The floor is deliberately not configurable — a configurable
 * accessibility floor is not a floor. What a viewer can ask for is more:
 * larger text (every size times `largerText.scale`) and higher contrast
 * (pure black and white, and a thicker focus ring). Both only ever move
 * away from the floor; see theme.ts.
 */
export const type = {
  /** Absolute minimum for anything a viewer has to read. */
  bodyPt: 32,
  headlinePt: 48,
  displayPt: 64,
} as const;

export const motion = {
  /** Nothing longer, nothing faster, nothing that flashes. */
  durationMs: 200,
  easing: 'ease-out',
} as const;

export const contrast = {
  /** WCAG AAA, not AA. */
  minRatio: 7,
  /** With higher contrast on: every word on its ground at least this. Black and white is 21:1. */
  highContrastMinRatio: 15,
} as const;

/** Larger text: every type size times this, so the 32pt floor becomes 40pt. */
export const largerText = {
  scale: 1.25,
} as const;

/** The focus ring: a ring, never a colour change alone. Thicker with higher contrast on. */
export const focusRing = {
  standardDp: 2,
  highContrastDp: 6,
  /**
   * With higher contrast on, every button is outlined at rest as well — a
   * black button on a black card is otherwise only its words — and the
   * ring is the same outline, three times as thick.
   */
  highContrastRestDp: 2,
} as const;

export const limits = {
  maxActions: 3,
  maxListItems: 3,
  /**
   * A card's detail text is cut at five lines, so no producer can push the
   * card's buttons off the screen. (A long generated summary once did, on a
   * Vega virtual device.)
   */
  maxDetailLines: 5,
} as const;

/** Vega's logical screen, and the card's spacing within it. */
export const layout = {
  screenHeightDp: 540,
  screenWidthDp: 960,
  /** Where a card is kept from the screen's left and right edges: inside the television's safe area. */
  cardFromSideDp: 48,
  /**
   * What is kept clear above and below a card: it sits this far from the
   * bottom edge, inside the television's safe area, and must leave as much
   * above it (constraints.ts assertCardFits).
   */
  screenMarginDp: 32,
  cardPaddingDp: 32,
  sectionGapDp: 20,
  textGapDp: 12,
  actionPaddingVerticalDp: 20,
  /** A card over a programme (CalmCard's `compact`). */
  compactPaddingDp: 24,
  compactGapDp: 16,
  compactTextGapDp: 4,
  lineHeight: { headline: 1.25, body: 1.4 },
} as const;

/** No red anywhere. Red on a television means "something is wrong with you". */
export const palette = {
  ink: '#F4F1EA',
  inkDim: '#C8C2B6',
  ground: '#12100E',
  raised: '#1E1B17',
  accent: '#E8B75D',
  focus: '#FFFFFF',
} as const;

/**
 * Higher contrast: pure black and white. Every word is white on black
 * (21:1), the card is black with a white edge, and the first button is no
 * longer amber: every button is black with white words, outlined, and the
 * focus is the thicker ring (focusRing). Still no red, by construction.
 */
export const highContrastPalette = {
  ink: '#FFFFFF',
  inkDim: '#FFFFFF',
  ground: '#000000',
  raised: '#000000',
  accent: '#FFFFFF',
  focus: '#FFFFFF',
} as const;

/** The six colours a component may use, in either palette. */
export interface Palette {
  readonly ink: string;
  readonly inkDim: string;
  readonly ground: string;
  readonly raised: string;
  readonly accent: string;
  readonly focus: string;
}
