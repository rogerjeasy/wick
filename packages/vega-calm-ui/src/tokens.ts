/**
 * Design tokens. Deliberately not configurable — a configurable accessibility
 * floor is not a floor.
 */
export const type = {
  /** Absolute minimum. docs/WICK.md Principle 7. */
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
