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
/**
 * Above and below the caption where "Carry on" is a line of it (carryOn
 * below): the progress line sits in the room above the words, and nothing
 * is kept below them — the room a third line needs, at 40pt, with the
 * quiet line, where there is no picture left to give it.
 */
export const TIGHT_CAPTION_PADDING = { top: 8, bottom: 0 } as const;
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

/**
 * How tall each row is, and the pictures with them, with or without the
 * quiet line, with captions of so many lines: a film's title's one or two,
 * and one more where "Carry on" has no room over the picture (carryOn below).
 */
export function homeHeights(theme: CalmTheme, quiet: boolean, titles: number = 1, tightCaption = false): HomeHeights {
  const ring = 2 * theme.ring(HOME_RING_DP).footprintDp;
  const line = theme.lineHeight('body');
  const question = theme.lineHeight('headline');
  const captionPadding = tightCaption ? TIGHT_CAPTION_PADDING.top + TIGHT_CAPTION_PADDING.bottom : 2 * CAPTION_PADDING_DP;
  const tileWithoutPoster = captionPadding + titles * line + ring;
  const quietRow = line + 2 * QUIET_PADDING.vertical + ring;
  const pills = line + 2 * PILL_PADDING.vertical + ring;
  const rows = question + tileWithoutPoster + pills + (quiet ? quietRow : 0);
  const gaps = HOME_SCREEN.gap * (quiet ? 3 : 2);
  const left = Math.floor(HOME_SCREEN.height - 2 * HOME_SCREEN.paddingVertical - rows - gaps);
  const poster = left < POSTER_MIN_DP ? 0 : Math.min(POSTER_MAX_DP, left);
  return { question, tileWithoutPoster, quiet: quiet ? quietRow : 0, pills, poster };
}

/** The whole height of the screen as drawn: never more than the screen. */
export function homeHeight(theme: CalmTheme, quiet: boolean, titles: number = 1, tightCaption = false): number {
  const h = homeHeights(theme, quiet, titles, tightCaption);
  return 2 * HOME_SCREEN.paddingVertical + h.question + h.tileWithoutPoster + h.poster + h.pills + h.quiet + HOME_SCREEN.gap * (quiet ? 3 : 2);
}

/*
 * Her day at the top (home/herDay.ts): the greeting in place of the
 * question, the date beside it, and a panel of who is coming under it.
 *
 * The same 540dp, so something has to give. In this order, and never a word
 * cut: the films' pictures first (words come before pictures), then the
 * lines about who is coming from the last, then her name from the greeting
 * — and the date last of all. Where even the plain greeting and the date
 * will not share a row, and the panel has no room for the date, the date is
 * the headline and the greeting goes: knowing what day it is comes first.
 */

/** Inside the day's panel, around its lines. It is not pressed, so it has no ring. */
export const DAY_PADDING = { horizontal: 20, vertical: 4 } as const;
/** Between the greeting and the panel under it: closer than the rows, since they are one thing. */
export const DAY_GAP_DP = 12;
/** Between one visit and the next in the panel, so two that wrap do not read as one. */
export const DAY_LINE_GAP_DP = 8;

/** How wide words are estimated to be at a size: a letter is half the type size (theme.ts GLYPH_WIDTH_EM). */
const widthOf = (words: string, pt: number): number => words.length * pt * GLYPH_WIDTH_EM;

/** The lines a sentence takes in the day's panel, wrapping at spaces. */
export function dayLines(theme: CalmTheme, sentence: string): number {
  const perLine = Math.max(1, Math.floor((HOME_ROW_DP - 2 * DAY_PADDING.horizontal) / (theme.fontSize('body') * GLYPH_WIDTH_EM)));
  let lines = 1;
  let used = 0;
  for (const word of sentence.split(/\s+/).filter(Boolean)) {
    const needed = used === 0 ? word.length : used + 1 + word.length;
    if (needed <= perLine) used = needed;
    else {
      lines += 1;
      used = word.length;
    }
  }
  return lines;
}

export interface DayText {
  readonly greeting: string;
  readonly greetingPlain: string;
  readonly date: string;
  readonly coming: readonly string[];
}

export interface CareLayout {
  /** The headline: the greeting with her name, without it, or — with no room for both — the date itself. */
  readonly headline: string;
  /** The date, in the headline's row, after the greeting. Absent when it is in the panel or is the headline. */
  readonly dateBeside?: string;
  /** What the panel says, in order: the date first when it is not in the headline's row, then who is coming. */
  readonly panel: readonly string[];
  /** The lines each of those takes. */
  readonly panelLines: readonly number[];
  /** The panel's height, with its padding; 0 when there is none. */
  readonly panelHeight: number;
  /** The films' pictures: what is left, or none. */
  readonly poster: number;
}

/** How her day sits on the home screen, with the quiet row or without it, with film titles of so many lines. */
export function careLayout(theme: CalmTheme, day: DayText, quiet: boolean, titles: number = 1, tightCaption = false): CareLayout {
  const h = homeHeights(theme, quiet, titles, tightCaption);
  const line = theme.lineHeight('body');
  // Everything but the panel and the pictures: the headline, the films' words, the pills, the quiet row, and their gaps.
  const fixed = h.question + h.tileWithoutPoster + h.pills + h.quiet + HOME_SCREEN.gap * (quiet ? 3 : 2);
  const room = HOME_SCREEN.height - 2 * HOME_SCREEN.paddingVertical - fixed;

  const besideFits = (greeting: string): boolean => widthOf(greeting, theme.fontSize('headline')) + HOME_SCREEN.gap + widthOf(day.date, theme.fontSize('body')) <= HOME_ROW_DP;
  const headlineFits = (words: string): boolean => widthOf(words, theme.fontSize('headline')) <= HOME_ROW_DP;

  const panelFor = (sentences: readonly string[]): { readonly panel: string[]; readonly lines: number[]; readonly height: number } => {
    const panel: string[] = [];
    const lines: number[] = [];
    let height = 0;
    for (const sentence of sentences) {
      const n = dayLines(theme, sentence);
      const add = (panel.length === 0 ? DAY_GAP_DP + 2 * DAY_PADDING.vertical : DAY_LINE_GAP_DP) + n * line;
      // In order, and none after the first that does not fit: the soonest visit is never left out for a later one.
      if (height + add > room) break;
      panel.push(sentence);
      lines.push(n);
      height += add;
    }
    return { panel, lines, height };
  };

  let headline: string;
  let dateBeside: string | undefined;
  let sentences: readonly string[];
  if (besideFits(day.greeting)) {
    headline = day.greeting;
    dateBeside = day.date;
    sentences = day.coming;
  } else if (besideFits(day.greetingPlain)) {
    headline = day.greetingPlain;
    dateBeside = day.date;
    sentences = day.coming;
  } else {
    headline = headlineFits(day.greeting) ? day.greeting : day.greetingPlain;
    sentences = [day.date, ...day.coming];
  }
  let built = panelFor(sentences);
  // The date had to go to the panel, and the panel had no room for it: the date is the headline instead.
  if (dateBeside === undefined && built.panel[0] !== day.date) {
    headline = day.date;
    built = panelFor(day.coming);
  }
  const panelHeight = built.panel.length === 0 ? 0 : built.height - DAY_GAP_DP;
  const left = Math.floor(room - built.height);
  const poster = left < POSTER_MIN_DP ? 0 : Math.min(POSTER_MAX_DP, left);
  return { headline, ...(dateBeside !== undefined ? { dateBeside } : {}), panel: built.panel, panelLines: built.lines, panelHeight, poster };
}

/*
 * A film she left part-way (home/order.ts): first in the row, and marked
 * "Carry on" with how long is left and a thin progress line over the
 * bottom of its picture. Over the picture: "Carry on" at its top-left, in
 * the amber of a first button, and the minutes left at its bottom-right,
 * just above the line — each on its own chip, so the words never sit on the
 * picture itself. Where the picture is too short for both, or a chip would
 * not fit its width, "Carry on" is a line of the caption instead, under the
 * title, with the progress line above it: the words are never cut, and the
 * pictures give way first, as everywhere on this screen. Where even that
 * line is not there to give (40pt, higher contrast and a quiet line), the
 * progress line alone marks the film, and the screen reader says the words.
 */

/** Around the words on a chip over a picture. */
export const CHIP_PADDING = { horizontal: 12, vertical: 2 } as const;
/** How far a chip, and the progress line, stand in from the picture's edges. */
export const CHIP_INSET_DP = 8;
/** The progress line over the bottom of a picture, or under a caption. */
export const TILE_PROGRESS_DP = 6;

/** A chip's height: a line of body type and its padding. */
export function chipHeightDp(theme: CalmTheme): number {
  return theme.lineHeight('body') + 2 * CHIP_PADDING.vertical;
}

/** The inside of a tile: a third of the row, less the gaps and its ring. */
export function tileInnerWidthDp(theme: CalmTheme): number {
  return (HOME_ROW_DP - 2 * HOME_SCREEN.gap) / 3 - 2 * theme.ring(HOME_RING_DP).footprintDp;
}

/** Whether "Carry on" and the minutes left go over a picture this tall, whole, in this theme. */
export function carryOnOverPoster(theme: CalmTheme, posterDp: number, chips: { readonly carryOn: string; readonly left: string }): boolean {
  if (posterDp <= 0) return false;
  const needed = 2 * chipHeightDp(theme) + TILE_PROGRESS_DP + 3 * CHIP_INSET_DP;
  const room = tileInnerWidthDp(theme) - 2 * CHIP_INSET_DP;
  const chip = (words: string): number => widthOf(words, theme.fontSize('body')) + 2 * CHIP_PADDING.horizontal;
  return posterDp >= needed && chip(chips.carryOn) <= room && chip(chips.left) <= room;
}

export interface HomeLayout {
  /** Her day, where there is one. */
  readonly care?: CareLayout | undefined;
  /** The films' pictures. */
  readonly poster: number;
  /** The lines under each picture: the title's, and "Carry on" when it is not over the picture. */
  readonly captionLines: number;
  /** The caption's padding is TIGHT_CAPTION_PADDING: "Carry on" is a line of it. */
  readonly tightCaption: boolean;
  /**
   * Where "Carry on" goes for a film left part-way: over its picture, in
   * its caption — or, at 40pt with higher contrast and a quiet line, where
   * the screen has no line left, only the progress line, the words said to
   * the screen reader. Absent when no film is.
   */
  readonly carryOn?: 'over' | 'caption' | 'line' | undefined;
}

/** The whole home screen's layout: her day, the pictures, and where "Carry on" goes. */
export function homeLayout(
  theme: CalmTheme,
  input: { readonly quiet: boolean; readonly titles: 1 | 2; readonly day?: DayText | undefined; readonly carryOn?: { readonly carryOn: string; readonly left: string } | undefined },
): HomeLayout {
  const at = (captionLines: number, tight: boolean): { care?: CareLayout; poster: number } => {
    if (input.day) {
      const care = careLayout(theme, input.day, input.quiet, captionLines, tight);
      return { care, poster: care.poster };
    }
    return { poster: homeHeights(theme, input.quiet, captionLines, tight).poster };
  };
  const plain = at(input.titles, false);
  if (!input.carryOn) return { ...plain, captionLines: input.titles, tightCaption: false };
  if (carryOnOverPoster(theme, plain.poster, input.carryOn)) return { ...plain, captionLines: input.titles, tightCaption: false, carryOn: 'over' };
  const caption = at(input.titles + 1, true);
  // The line fits, and takes no line about who is coming with it.
  const fits = homeHeight(theme, input.quiet, input.titles + 1, true) - homeHeights(theme, input.quiet, input.titles + 1, true).poster + caption.poster <= HOME_SCREEN.height;
  const keepsDay = !plain.care || (caption.care?.panel.length ?? 0) >= plain.care.panel.length;
  if (fits && keepsDay) return { ...caption, captionLines: input.titles + 1, tightCaption: true, carryOn: 'caption' };
  // No room for even that: the progress line alone, at the top of the caption, and the words to the screen reader.
  return { ...plain, captionLines: input.titles, tightCaption: false, carryOn: 'line' };
}

/*
 * The pills: her light, her mantelpiece, Easier to see and How Wick works,
 * each an icon and its words. Four do not fit one row with their words at
 * 32pt, and the row is not what should be cut — nor the films. So a pill
 * may be its icon alone at rest, and it shows its words when it has the
 * focus: she always reads what OK will do before she presses it, and the
 * screen reader always hears the words. The pills give their words up in
 * this order, and only as many as the row needs: the mantelpiece, her
 * light, Easier to see, and How Wick works last of all. The row is
 * measured with the widest of them open, so the focus moving never pushes
 * a pill off the screen.
 */

/** Between a pill's icon and its words. */
export const PILL_ICON_GAP_DP = 8;
/** Which pills give up their words first, when the row needs the room. */
export const PILL_WORDS_GIVE_WAY: readonly string[] = ['mantel', 'light', 'seeing', 'tour'];

export interface PillSpec {
  readonly id: string;
  readonly words: string;
}

/** A pill's width: its icon, its words if shown, its padding and its ring. */
export function pillWidthDp(theme: CalmTheme, words: string | undefined): number {
  const icon = theme.preferences.largerText ? 40 : 32;
  const text = words ? PILL_ICON_GAP_DP + widthOf(words, theme.fontSize('body')) : 0;
  return icon + text + 2 * PILL_PADDING.horizontal + 2 * theme.ring(HOME_RING_DP).footprintDp;
}

/** The row's width with these pills showing their words at rest, and the widest of the others opened by the focus. */
export function pillRowDp(theme: CalmTheme, pills: readonly PillSpec[], wordsAtRest: ReadonlySet<string>): number {
  let rest = 0;
  let opening = 0;
  for (const pill of pills) {
    const shut = pillWidthDp(theme, wordsAtRest.has(pill.id) ? pill.words : undefined);
    rest += shut;
    opening = Math.max(opening, pillWidthDp(theme, pill.words) - shut);
  }
  return rest + opening + HOME_SCREEN.gap * Math.max(0, pills.length - 1);
}

/** Which pills show their words at rest: all that the row has room for, giving way in PILL_WORDS_GIVE_WAY's order. */
export function pillsWithWords(theme: CalmTheme, pills: readonly PillSpec[]): ReadonlySet<string> {
  const shown = new Set(pills.map((pill) => pill.id));
  for (const id of PILL_WORDS_GIVE_WAY) {
    if (pillRowDp(theme, pills, shown) <= HOME_ROW_DP) break;
    shown.delete(id);
  }
  return shown;
}
