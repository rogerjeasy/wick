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
 * A film's title is never cut. At 40pt "Big Buck Bunny" does not fit a
 * tile's width (seen on the Vega Virtual Device: "Big Buck …"), so a title
 * takes two lines there, and the lines are counted before the picture is
 * given its height. A picture shorter than POSTER_MIN_DP is not worth the
 * squint: then the tile is its title alone.
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
/** Nor shorter than this: with less room than that, a tile has no picture at all. */
export const POSTER_MIN_DP = 60;

/** An average letter's width as a share of the type size, as vega-calm-ui estimates it (theme.ts GLYPH_WIDTH_EM). */
const GLYPH_WIDTH_EM = 0.5;

/**
 * The padding either side of a film's title. With higher contrast on the
 * ring is thicker, and what it adds comes out of this padding — not out of
 * the title's width: with it out of the width, "Big Buck Bunny" was cut at
 * 32pt on the Vega Virtual Device.
 */
export function captionPaddingDp(theme: CalmTheme): number {
  return CAPTION_PADDING_DP - (theme.ring(HOME_RING_DP).footprintDp - HOME_RING_DP);
}

/** How wide a film's title may be inside its tile: a third of the row, less the gaps, the tile's padding and its ring. The same in every contrast. */
export function titleWidthDp(theme: CalmTheme): number {
  return (HOME_ROW_DP - 2 * HOME_SCREEN.gap) / 3 - 2 * captionPaddingDp(theme) - 2 * theme.ring(HOME_RING_DP).footprintDp;
}

/**
 * The lines the longest of these titles takes in a tile, wrapping at
 * spaces — one, or two where a word would not fit beside the next. A title
 * longer than two lines is not one the catalogue has.
 */
export function titleLines(theme: CalmTheme, titles: readonly string[]): 1 | 2 {
  const perLine = Math.floor(titleWidthDp(theme) / (theme.fontSize('body') * GLYPH_WIDTH_EM));
  const fits = (title: string): boolean => {
    let used = 0;
    let lines = 1;
    for (const word of title.split(/\s+/).filter(Boolean)) {
      const needed = used === 0 ? word.length : used + 1 + word.length;
      if (needed <= perLine) used = needed;
      else {
        lines += 1;
        used = word.length;
      }
    }
    return lines === 1;
  };
  return titles.every(fits) ? 1 : 2;
}

export interface HomeHeights {
  readonly question: number;
  readonly tileWithoutPoster: number;
  readonly quiet: number;
  readonly pills: number;
  /** The films' pictures: what is left. */
  readonly poster: number;
}

/** How tall each row is, and the pictures with them, with or without the quiet line, with titles of so many lines. */
export function homeHeights(theme: CalmTheme, quiet: boolean, titles: 1 | 2 = 1): HomeHeights {
  const ring = 2 * theme.ring(HOME_RING_DP).footprintDp;
  const line = theme.lineHeight('body');
  const question = theme.lineHeight('headline');
  const tileWithoutPoster = 2 * CAPTION_PADDING_DP + titles * line + ring;
  const quietRow = line + 2 * QUIET_PADDING.vertical + ring;
  const pills = line + 2 * PILL_PADDING.vertical + ring;
  const rows = question + tileWithoutPoster + pills + (quiet ? quietRow : 0);
  const gaps = HOME_SCREEN.gap * (quiet ? 3 : 2);
  const left = Math.floor(HOME_SCREEN.height - 2 * HOME_SCREEN.paddingVertical - rows - gaps);
  const poster = left < POSTER_MIN_DP ? 0 : Math.min(POSTER_MAX_DP, left);
  return { question, tileWithoutPoster, quiet: quiet ? quietRow : 0, pills, poster };
}

/** The whole height of the screen as drawn: never more than the screen. */
export function homeHeight(theme: CalmTheme, quiet: boolean, titles: 1 | 2 = 1): number {
  const h = homeHeights(theme, quiet, titles);
  return 2 * HOME_SCREEN.paddingVertical + h.question + h.tileWithoutPoster + h.poster + h.pills + h.quiet + HOME_SCREEN.gap * (quiet ? 3 : 2);
}
