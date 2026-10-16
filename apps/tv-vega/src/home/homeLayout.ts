/**
 * The home screen's heights, in the theme it is drawn in (HomeScreen.tsx) —
 * pure, and held by home/__tests__/homeLayout.test.ts.
 *
 * Four rows on a 960x540dp screen, inside the television's safe area (48dp
 * either side, 32 above and below): the question; the three films; the
 * quiet line — what is waiting, or who looked in — when there is one; and
 * the pills: her light, her mantelpiece, and Easier to see. Every row is
 * as tall as its words, at whatever size they are set, and the films'
 * pictures have what is left. So with larger text on the pictures are
 * shorter and the words are not: words come before pictures for someone
 * who asked to see them better.
 *
 * Each pill and tile has a focus ring, thicker with higher contrast on
 * (vega-calm-ui theme.ts `ring`), and the ring's room is counted too.
 */
import type { CalmTheme } from '@wick/vega-calm-ui';

/** Vega's logical screen, and the home screen's safe-area padding. */
export const HOME_SCREEN = { width: 960, height: 540, paddingHorizontal: 48, paddingVertical: 32, gap: 24 } as const;

/** The widest a row may be. */
export const HOME_ROW_DP = HOME_SCREEN.width - 2 * HOME_SCREEN.paddingHorizontal;

/** The ring around a tile or a pill, at the floor (theme.ts `ring`). */
export const HOME_RING_DP = 4;

/** Inside a tile, under its picture: the title's padding. */
export const CAPTION_PADDING_DP = 16;
/** Inside a pill, around its words. */
export const PILL_PADDING = { horizontal: 16, vertical: 2 } as const;
/** Inside the quiet line, around its words. */
export const QUIET_PADDING = { horizontal: 20, vertical: 6 } as const;

/** The pictures are never taller than this, however much room there is. */
export const POSTER_MAX_DP = 200;

export interface HomeHeights {
  readonly question: number;
  readonly tileWithoutPoster: number;
  readonly quiet: number;
  readonly pills: number;
  /** The films' pictures: what is left. */
  readonly poster: number;
}

/** How tall each row is, and the pictures with them, with or without the quiet line. */
export function homeHeights(theme: CalmTheme, quiet: boolean): HomeHeights {
  const ring = 2 * theme.ring(HOME_RING_DP).footprintDp;
  const line = theme.lineHeight('body');
  const question = theme.lineHeight('headline');
  const tileWithoutPoster = 2 * CAPTION_PADDING_DP + line + ring;
  const quietRow = line + 2 * QUIET_PADDING.vertical + ring;
  const pills = line + 2 * PILL_PADDING.vertical + ring;
  const rows = question + tileWithoutPoster + pills + (quiet ? quietRow : 0);
  const gaps = HOME_SCREEN.gap * (quiet ? 3 : 2);
  const poster = Math.floor(HOME_SCREEN.height - 2 * HOME_SCREEN.paddingVertical - rows - gaps);
  return { question, tileWithoutPoster, quiet: quiet ? quietRow : 0, pills, poster: Math.min(POSTER_MAX_DP, poster) };
}

/** The whole height of the screen as drawn: never more than the screen. */
export function homeHeight(theme: CalmTheme, quiet: boolean): number {
  const h = homeHeights(theme, quiet);
  return 2 * HOME_SCREEN.paddingVertical + h.question + h.tileWithoutPoster + h.poster + h.pills + h.quiet + HOME_SCREEN.gap * (quiet ? 3 : 2);
}
