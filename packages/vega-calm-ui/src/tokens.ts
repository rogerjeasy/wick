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

/**
 * Motion (docs/design/DESIGN.md §4). Motion says where something came from
 * or went, in 200ms or less, and stops: nothing loops, blinks or moves by
 * itself. The one thing longer is the hold line, which is the hold itself.
 * With reduced motion asked for, every one of these is an instant change
 * (`motionTimings`, theme.ts).
 */
export const motion = {
  /** Nothing longer, nothing faster, nothing that flashes. */
  durationMs: 200,
  /** A card arriving: opacity 0 to 1, and `enterRiseDp` up. */
  enterMs: 200,
  /** A card leaving: opacity 1 to 0. */
  exitMs: 150,
  /** A tile taking the focus: its scale 1 to `focusScale`. Tiles only, never words alone. */
  focusMs: 150,
  focusScale: 1.04,
  /** How far a card rises as it arrives. */
  enterRiseDp: 12,
  /** Everything that enters or moves: cubic-bezier(0.2, 0, 0, 1), as its four control values. */
  easing: [0.2, 0, 0, 1] as const,
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
  /** The focused tile's surface, and the film's bar: a step up from `raised`, words still at 7:1 and more. */
  raisedHigh: '#2A2621',
  accent: '#E8B75D',
  /** The unfilled part of a progress line. Never words. */
  track: '#4A443B',
  /** Over a film, behind a card: this colour at `scrimOpacity` (theme.ts). */
  scrim: '#12100E',
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
  raisedHigh: '#000000',
  accent: '#FFFFFF',
  // Black, like the ground: a progress line is then outlined in white (theme.ts `trackEdgeDp`), and filled white.
  track: '#000000',
  scrim: '#000000',
  focus: '#FFFFFF',
} as const;

/** How much of a film shows through the scrim behind a card: 82% scrim, or 90% with higher contrast on. */
export const scrimOpacity = {
  standard: 0.82,
  highContrast: 0.9,
} as const;

/** The nine colours a component may use, in either palette. */
export interface Palette {
  readonly ink: string;
  readonly inkDim: string;
  readonly ground: string;
  readonly raised: string;
  /** The focused tile's surface, and the film's bar. */
  readonly raisedHigh: string;
  readonly accent: string;
  /** The unfilled part of a progress line: never words. */
  readonly track: string;
  /** Behind a card over a film, at the theme's `scrimOpacity`. */
  readonly scrim: string;
  readonly focus: string;
}
