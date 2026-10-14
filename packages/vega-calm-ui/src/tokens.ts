/**
 * Design tokens. Deliberately not configurable — a configurable accessibility
 * floor is not a floor.
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
