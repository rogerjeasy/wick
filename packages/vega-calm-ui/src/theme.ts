/**
 * What a viewer can ask for beyond the floor: larger text and higher
 * contrast. Pure — no React, no platform — so every number is tested
 * without a device (src/__tests__/theme.test.ts).
 *
 * The floor does not move down. Both preferences only ever move away from
 * it: larger text multiplies every type size by 1.25 (32pt becomes 40pt),
 * and higher contrast swaps the palette for pure black and white (21:1)
 * with a ring three times as thick. A theme is checked when it is made —
 * every size against the floor, every pair of colours a word is written
 * in against the ratio that theme promises — so a theme that breaks its
 * promise throws before anything is drawn with it.
 *
 * Components never read the tokens' colours or sizes straight: they ask
 * the theme they are drawn in (`useCalmTheme()`, CalmPreferences.tsx), so
 * a preference applies everywhere at once, not screen by screen.
 */
import { CalmViolation, alarmHue, contrastRatio, type TypeRole } from './constraints.js';
import { contrast, focusRing, highContrastPalette, largerText, layout, limits, palette, type, type Palette } from './tokens.js';

/** What the viewer has asked for. Both off is the floor itself. */
export interface CalmPreferences {
  /** Every type size times 1.25. */
  readonly largerText: boolean;
  /** Pure black and white, and a thicker focus ring. */
  readonly higherContrast: boolean;
}

export const STANDARD_PREFERENCES: CalmPreferences = { largerText: false, higherContrast: false };

/** The three sizes a component may set type at. */
export interface TypeScale {
  readonly bodyPt: number;
  readonly headlinePt: number;
  readonly displayPt: number;
}

/** A button's colours: what it is drawn in, and what its words are written in. Its edge is the ring's (`ring`). */
export interface ActionColours {
  readonly background: string;
  readonly label: string;
}

/**
 * The ring that shows the focus, as two styles of the same footprint: the
 * one at rest, and the one with the focus. With higher contrast on the
 * ring is thicker, and the button is outlined at rest; the difference is
 * made up in margin, so moving the focus moves nothing on the screen.
 */
export interface Ring {
  readonly rest: { readonly borderWidth: number; readonly borderColor: string; readonly margin: number };
  readonly focused: { readonly borderWidth: number; readonly borderColor: string; readonly margin: number };
  /** How far the ring reaches out from the element's own box, either side: what a layout must leave room for. */
  readonly footprintDp: number;
}

export interface CalmTheme {
  readonly preferences: CalmPreferences;
  readonly type: TypeScale;
  readonly palette: Palette;
  /** The least contrast between any word and its ground in this theme. */
  readonly minContrast: number;
  /** The width of the card's own edge: none, or with higher contrast on a white line around a black card. */
  readonly cardEdgeDp: number;
  /** A type role's size in this theme. Never below 32pt. */
  fontSize(role: TypeRole): number;
  /** The line a type role takes: its size times the line height the tokens give it. */
  lineHeight(role: TypeRole): number;
  actionColours(kind: 'primary' | 'secondary' | 'dismiss'): ActionColours;
  /**
   * The focus ring for an element whose ring is `standardDp` wide at the
   * floor: CalmCard's buttons are 2, the home screen's tiles 4. With higher
   * contrast on it is 4dp thicker (2 becomes 6).
   */
  ring(standardDp?: number): Ring;
}

const LINE_HEIGHT: Record<TypeRole, number> = {
  body: layout.lineHeight.body,
  headline: layout.lineHeight.headline,
  display: layout.lineHeight.headline,
};

/** How much thicker the ring is with higher contrast on: 2dp becomes 6. */
const RING_GAIN_DP = focusRing.highContrastDp - focusRing.standardDp;

function makeTheme(preferences: CalmPreferences): CalmTheme {
  const scale = preferences.largerText ? largerText.scale : 1;
  const sizes: TypeScale = { bodyPt: type.bodyPt * scale, headlinePt: type.headlinePt * scale, displayPt: type.displayPt * scale };
  const colours: Palette = preferences.higherContrast ? highContrastPalette : palette;
  const minContrast = preferences.higherContrast ? contrast.highContrastMinRatio : contrast.minRatio;
  const size = (role: TypeRole): number => ({ body: sizes.bodyPt, headline: sizes.headlinePt, display: sizes.displayPt })[role];

  const actionColours = (kind: 'primary' | 'secondary' | 'dismiss'): ActionColours => {
    // Higher contrast: every button black with white words, outlined (`ring`). Only the focus stands out: a
    // bold first button was seen, on the Vega Virtual Device, to read as the focused one.
    if (preferences.higherContrast) return { background: colours.ground, label: colours.ink };
    // The first button is amber, and light ink on amber is 1.6:1, so its words are written in the dark of the ground.
    return kind === 'primary' ? { background: colours.accent, label: colours.ground } : { background: colours.ground, label: colours.ink };
  };

  const ring = (standardDp: number = focusRing.standardDp): Ring => {
    if (!preferences.higherContrast) {
      return {
        rest: { borderWidth: standardDp, borderColor: 'transparent', margin: 0 },
        focused: { borderWidth: standardDp, borderColor: colours.focus, margin: 0 },
        footprintDp: standardDp,
      };
    }
    const focused = standardDp + RING_GAIN_DP;
    const rest = focusRing.highContrastRestDp;
    return {
      rest: { borderWidth: rest, borderColor: colours.ink, margin: focused - rest },
      focused: { borderWidth: focused, borderColor: colours.focus, margin: 0 },
      footprintDp: focused,
    };
  };

  const theme: CalmTheme = {
    preferences,
    type: sizes,
    palette: colours,
    minContrast,
    cardEdgeDp: preferences.higherContrast ? focusRing.highContrastRestDp : 0,
    fontSize: size,
    lineHeight: (role) => size(role) * LINE_HEIGHT[role],
    actionColours,
    ring,
  };
  checkTheme(theme);
  return theme;
}

/**
 * Every promise a theme makes, checked when it is made: nothing under 32pt;
 * every word on every ground it is drawn on at the theme's ratio — 7:1, or
 * 15:1 with higher contrast on; every button's words on that button; no
 * saturated red. A theme that fails throws, and nothing is drawn with it.
 */
export function checkTheme(theme: CalmTheme): void {
  for (const role of ['body', 'headline', 'display'] as const) {
    if (theme.fontSize(role) < type.bodyPt) {
      throw new CalmViolation(`${role} resolves to ${theme.fontSize(role)}pt, below the ${type.bodyPt}pt floor.`);
    }
  }
  for (const [foreground, background] of textPairs(theme)) {
    const ratio = contrastRatio(foreground, background);
    if (ratio < theme.minContrast) {
      throw new CalmViolation(
        `Contrast ${ratio.toFixed(2)}:1 between ${foreground} and ${background}; this theme promises ${theme.minContrast}:1.`,
      );
    }
  }
  for (const colour of Object.values(theme.palette)) {
    if (alarmHue(colour) !== null) throw new CalmViolation(`${colour} is a saturated red; a calm surface never uses it.`);
  }
}

/** Every pair of colours a word is written in on a ground, in a theme: what checkTheme holds to its ratio. */
export function textPairs(theme: CalmTheme): readonly (readonly [foreground: string, background: string])[] {
  const { ink, inkDim, ground, raised } = theme.palette;
  const pairs: [string, string][] = [
    [ink, raised],
    [inkDim, raised],
    [ink, ground],
    [inkDim, ground],
  ];
  for (const kind of ['primary', 'secondary', 'dismiss'] as const) {
    const colours = theme.actionColours(kind);
    pairs.push([colours.label, colours.background]);
  }
  return pairs;
}

const THEMES = new Map<string, CalmTheme>();

/**
 * The theme for a viewer's preferences. There are four, made once each and
 * then handed out again, so a component can compare themes by identity
 * and styles made for one are made once (stylesFor).
 */
export function calmTheme(preferences: CalmPreferences = STANDARD_PREFERENCES): CalmTheme {
  const key = `${preferences.largerText ? 1 : 0}${preferences.higherContrast ? 1 : 0}`;
  let theme = THEMES.get(key);
  if (!theme) {
    theme = makeTheme({ largerText: preferences.largerText, higherContrast: preferences.higherContrast });
    THEMES.set(key, theme);
  }
  return theme;
}

const STYLES = new WeakMap<(theme: CalmTheme) => unknown, Map<CalmTheme, unknown>>();

/**
 * A component's styles for a theme: `make(theme)` once per theme, then the
 * same object again. Write a component's styles as a function of the theme
 * and call this (or `useCalmStyles`) where `StyleSheet.create` used to be.
 */
export function stylesFor<T>(make: (theme: CalmTheme) => T, theme: CalmTheme): T {
  let made = STYLES.get(make);
  if (!made) {
    made = new Map();
    STYLES.set(make, made);
  }
  if (!made.has(theme)) made.set(theme, make(theme));
  return made.get(theme) as T;
}

// ---------------------------------------------------------------------------
// Fitting a card at larger text.
// ---------------------------------------------------------------------------

/**
 * An average letter's width as a share of the type size, for estimating
 * how many lines words take. Half the size is wider than the 0.47 a plain
 * sans-serif measured on the Vega Virtual Device (the home screen's
 * question, 648dp at 48pt), so an estimate errs towards more lines.
 */
export const GLYPH_WIDTH_EM = 0.5;

/** The lines `text` takes in `widthDp` at `pt`, wrapping at spaces as a television does. At least one for any words; none for none. */
export function estimatedLines(text: string | undefined, widthDp: number, pt: number): number {
  const words = (text ?? '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const letter = pt * GLYPH_WIDTH_EM;
  const perLine = Math.max(1, Math.floor(widthDp / letter));
  let lines = 1;
  let used = 0;
  for (const word of words) {
    // A word longer than a line is broken across lines.
    let length = word.length;
    const needed = used === 0 ? length : used + 1 + length;
    if (needed <= perLine) {
      used = needed;
      continue;
    }
    if (used > 0) lines += 1;
    while (length > perLine) {
      length -= perLine;
      lines += 1;
    }
    used = length;
  }
  return lines;
}

/** CalmCard's own spacing, as its styles use it. */
export const CARD_BUTTON_PADDING_DP = 32;
export const CARD_BUTTON_GAP_DP = 16;
export const CARD_MEDIA_GAP_DP = 24;

/** How many rows a card's buttons take, wrapping as CalmCard's row does. */
export function estimatedActionRows(labels: readonly string[], widthDp: number, theme: CalmTheme): number {
  if (labels.length === 0) return 0;
  const ring = theme.ring().footprintDp;
  const letter = theme.type.bodyPt * GLYPH_WIDTH_EM;
  let rows = 1;
  let used = 0;
  for (const label of labels) {
    const width = label.length * letter + 2 * CARD_BUTTON_PADDING_DP + 2 * ring;
    const needed = used === 0 ? width : used + CARD_BUTTON_GAP_DP + width;
    if (needed <= widthDp || used === 0) {
      used = needed;
    } else {
      rows += 1;
      used = width;
    }
  }
  return rows;
}

/** What decides whether a card fits at larger text, beyond its shape. */
export interface CardFitInput {
  readonly compact?: boolean | undefined;
  /** Lines of detail the card asks for (CalmCard's `detailLines`); five when absent. */
  readonly detailLines?: number | undefined;
  readonly mediaHeightDp?: number | undefined;
  /** The width of the picture beside the words, if there is one. */
  readonly mediaWidthDp?: number | undefined;
  readonly headline: string;
  /** Each passage of words under the headline that must be read whole: the detail, a notice. */
  readonly passages: readonly (string | undefined)[];
  /** Lines kept for words that have not arrived yet (TwoPhaseCard keeps two). */
  readonly reservedLines?: number | undefined;
  readonly actionLabels: readonly string[];
}

export interface CardFit {
  /** The theme to draw the card in: the one asked for, or — when its words would not be whole at larger text — the same without larger text. */
  readonly theme: CalmTheme;
  /** How many lines of detail the card shows. */
  readonly detailLines: number;
  /** Drawn with the compact card's spacing: asked for, or the room a card at larger text needed. */
  readonly compactSpacing: boolean;
  /** The headline at body size, bold: a compact card's, or the last room a card at larger text can be given. */
  readonly bodyHeadline: boolean;
}

/**
 * How a card is drawn in a theme. At the floor it is as it always was. At
 * larger text every word is 1.25 times the size, and a card still has to
 * fit the screen with its buttons on it — and its words have to be whole.
 * The room comes from less card around the words, never from smaller
 * words: first the compact card's spacing, then its headline at body size
 * (40pt, bold). A card whose words would still not be whole is drawn at
 * the standard size, where it was made to fit. Whole at 32pt beats cut at
 * 40, and nothing is ever drawn under the floor.
 *
 * It is an estimate (GLYPH_WIDTH_EM), and it errs towards falling back.
 */
export function fitCard(input: CardFitInput, theme: CalmTheme): CardFit {
  const asked = input.detailLines ?? limits.maxDetailLines;
  const compact = input.compact === true;
  const asIs: CardFit = { theme, detailLines: asked, compactSpacing: compact, bodyHeadline: compact };
  if (!theme.preferences.largerText) return asIs;

  // Less card around the words first, then the headline at body size — and only then the standard size.
  const tries: readonly (readonly [compactSpacing: boolean, bodyHeadline: boolean])[] = compact
    ? [[true, true]]
    : [
        [false, false],
        [true, false],
        [true, true],
      ];
  for (const [compactSpacing, bodyHeadline] of tries) {
    const lines = detailLinesThatFit(input, theme, compactSpacing, bodyHeadline);
    if (lines !== undefined) return { theme, detailLines: Math.max(1, Math.min(asked, lines)), compactSpacing, bodyHeadline };
  }
  return { ...asIs, theme: calmTheme({ ...theme.preferences, largerText: false }) };
}

/** The lines of detail a card of that shape has room for, with all its words whole — or undefined if they would not be. */
function detailLinesThatFit(input: CardFitInput, theme: CalmTheme, compactSpacing: boolean, bodyHeadline: boolean): number | undefined {
  const asked = input.detailLines ?? limits.maxDetailLines;
  const padding = compactSpacing ? layout.compactPaddingDp : layout.cardPaddingDp;
  const inner = layout.screenWidthDp - 2 * layout.cardFromSideDp - 2 * padding - 2 * theme.cardEdgeDp;
  const textWidth = inner - (input.mediaWidthDp !== undefined ? input.mediaWidthDp + CARD_MEDIA_GAP_DP : 0);

  const headlineRole: TypeRole = bodyHeadline ? 'body' : 'headline';
  const headline = estimatedLines(input.headline, textWidth, theme.fontSize(headlineRole)) * theme.lineHeight(headlineRole);
  const body = theme.lineHeight('body');
  const [detail, ...rest] = input.passages;
  const detailLines = estimatedLines(detail, textWidth, theme.type.bodyPt);
  // The detail is cut at the lines the card asked for: words that need more are not whole.
  if (detailLines > asked) return undefined;
  const words = detailLines + rest.reduce((sum, passage) => sum + estimatedLines(passage, textWidth, theme.type.bodyPt), 0);
  const lines = Math.max(words, input.reservedLines ?? 0);

  const rows = estimatedActionRows(input.actionLabels, inner, theme);
  const actionRow = 2 * layout.actionPaddingVerticalDp + body + 2 * theme.ring().footprintDp;
  const actions = rows * actionRow + Math.max(0, rows - 1) * CARD_BUTTON_GAP_DP;
  const gap = compactSpacing ? layout.compactGapDp : layout.sectionGapDp;
  const textGap = compactSpacing ? layout.compactTextGapDp : layout.textGapDp;
  const room = layout.screenHeightDp - 2 * layout.screenMarginDp - 2 * padding - 2 * theme.cardEdgeDp - (rows > 0 ? gap + actions : 0);

  const wordsHeight = headline + (lines > 0 ? textGap + lines * body : 0);
  if (Math.max(wordsHeight, input.mediaHeightDp ?? 0) > room) return undefined;
  return Math.floor((room - headline - textGap) / body);
}
