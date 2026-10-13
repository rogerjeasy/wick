/**
 * The mantelpiece screen's measurements (MantelScreen.tsx), on Vega's
 * 960x540dp screen — pure, so they are held by a test without the view.
 *
 * One picture at a time, as large as the screen allows: the whole screen
 * less the television's safe area (48dp either side, 32 above and below,
 * as on the home screen), the one quiet line under the picture at 32pt, and
 * the gap between them. That leaves the picture 864x419dp, in which it is
 * fitted whole: four by three is 559x419, sixteen by nine 745x419, a tall
 * three by four 314x419.
 */
export const MANTEL_PADDING = { horizontal: 48, vertical: 32 } as const;

/** Between the picture and the line under it. */
export const MANTEL_GAP_DP = 12;

/** 32pt at the body's line height (packages/vega-calm-ui tokens). */
const LINE_DP = 32 * 1.4;

export const MANTEL_PICTURE_AREA = {
  width: 960 - 2 * MANTEL_PADDING.horizontal,
  height: Math.floor(540 - 2 * MANTEL_PADDING.vertical - MANTEL_GAP_DP - LINE_DP),
} as const;
