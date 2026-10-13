/**
 * The accessibility floor, as functions rather than review comments.
 *
 * docs/WICK.md Part 5 lists these as principles. A principle you can only
 * remember is one you will eventually forget at 2am before a deadline, so each
 * one here is a call that throws. The components below cannot render a card
 * that breaks them.
 */
import { layout, limits, palette, type } from './tokens.js';

export class CalmViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalmViolation';
  }
}

/** Principle 6: three, never four. */
export function assertActionLimit(count: number): void {
  if (count > limits.maxActions) {
    throw new CalmViolation(
      `${count} actions: a card may have at most ${limits.maxActions}. ` +
        'Three is the product decision, not a layout constraint.',
    );
  }
}

/** Principle 6 again, for any list a card shows. */
export function assertItemLimit(count: number): void {
  if (count > limits.maxListItems) {
    throw new CalmViolation(
      `${count} items: a card may show at most ${limits.maxListItems}.`,
    );
  }
}

export type TypeRole = 'body' | 'headline' | 'display';

/** Principle 7: nothing below 32pt reaches the screen. */
export function fontSize(role: TypeRole): number {
  const size = { body: type.bodyPt, headline: type.headlinePt, display: type.displayPt }[role];
  if (size < type.bodyPt) {
    throw new CalmViolation(`${role} resolves to ${size}pt, below the ${type.bodyPt}pt floor.`);
  }
  return size;
}

/**
 * The tallest a text-only card can be: padding, a one-line headline, the
 * detail at its line limit, and one row of actions. CalmCard's own styles
 * are built from the same tokens, so this is the card's real height.
 */
export function maxCardHeightDp(): number {
  const headline = type.headlinePt * layout.lineHeight.headline;
  const detail = limits.maxDetailLines * type.bodyPt * layout.lineHeight.body;
  const actionRow = layout.actionPaddingVerticalDp * 2 + type.bodyPt * layout.lineHeight.body;
  return layout.cardPaddingDp * 2 + headline + layout.textGapDp + detail + layout.sectionGapDp + actionRow;
}

/** What decides a text-only card's height: its spacing, and how many lines of detail it may show. */
export interface CardShape {
  /** CalmCard's `compact`: tighter spacing, and the headline at body size. */
  readonly compact?: boolean | undefined;
  /** Lines of detail. Five unless the card asks for more (CalmCard's `detailLines`). */
  readonly detailLines?: number | undefined;
}

/**
 * The height of a text-only card of that shape: padding, a one-line
 * headline, the detail at its line limit, and one row of actions — from the
 * tokens CalmCard's own styles are built from. With nothing asked for it is
 * maxCardHeightDp().
 */
export function cardHeightDp(shape: CardShape): number {
  const compact = shape.compact === true;
  const lines = shape.detailLines ?? limits.maxDetailLines;
  const body = type.bodyPt * layout.lineHeight.body;
  const headline = compact ? body : type.headlinePt * layout.lineHeight.headline;
  const actionRow = layout.actionPaddingVerticalDp * 2 + body;
  return (
    (compact ? layout.compactPaddingDp : layout.cardPaddingDp) * 2 +
    headline +
    (compact ? layout.compactTextGapDp : layout.textGapDp) +
    lines * body +
    (compact ? layout.compactGapDp : layout.sectionGapDp) +
    actionRow
  );
}

/**
 * The buttons are always on the screen. A card whose detail must be read
 * whole may ask for more than five lines — and gets them only if, at the
 * 32pt floor, it still fits the screen with its margins. The room comes from
 * less card around the words (`compact`), never from smaller words.
 */
export function assertCardFits(shape: CardShape): void {
  const lines = shape.detailLines ?? limits.maxDetailLines;
  if (!Number.isInteger(lines) || lines < 1) {
    throw new CalmViolation(`${lines} lines of detail: a card shows a whole number of lines, and at least one.`);
  }
  const height = cardHeightDp(shape);
  const room = layout.screenHeightDp - 2 * layout.screenMarginDp;
  if (height > room) {
    throw new CalmViolation(
      `${lines} lines of detail make ${shape.compact ? 'a compact' : 'a'} card ${height.toFixed(0)}dp tall; ` +
        `the screen has ${room}dp for it. The buttons would be pushed off the screen.`,
    );
  }
}

/** sRGB relative luminance, per WCAG. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new CalmViolation(`Not a 6-digit hex colour: "${hex}"`);

  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Principle 7: AAA, not AA. Checked, not assumed. */
export function assertContrast(foreground: string, background: string): void {
  const ratio = contrastRatio(foreground, background);
  if (ratio < 7) {
    throw new CalmViolation(
      `Contrast ${ratio.toFixed(2)}:1 between ${foreground} and ${background}; ` +
        'the floor is 7:1 (WCAG AAA).',
    );
  }
}

/**
 * No red. On a television in someone's living room, red means "something is
 * wrong with you" — and nothing Wick shows is ever that.
 *
 * Caught by hue rather than by blocklist, so a newly invented shade of red is
 * caught the same as #FF0000.
 */
export function assertNoAlarmColour(hex: string): void {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new CalmViolation(`Not a 6-digit hex colour: "${hex}"`);

  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return; // grey

  // Hue in degrees; red is the wedge around 0.
  let hue = 0;
  if (max === r) hue = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) hue = 60 * ((b - r) / (max - min)) + 120;
  else hue = 60 * ((r - g) / (max - min)) + 240;

  const saturated = (max - min) / max > 0.35;
  const isRed = hue >= 345 || hue <= 12;

  if (saturated && isRed) {
    throw new CalmViolation(
      `${hex} is a saturated red (hue ${hue.toFixed(0)}deg). ` +
        'No red, anywhere — docs/WICK.md Principle 8.',
    );
  }
}

/** The palette, pre-checked, so a component never has to think about it. */
export const safe = palette;

/**
 * A button's own two colours: what it is drawn in, and what its words are
 * written in. The floor is 7:1 between those two — the words sit on the
 * button, not on the card behind it. The first button is amber, and light
 * ink on amber is 1.6:1, so its words are written in the dark of the ground
 * instead; every other button is the ground with light ink, as before.
 */
export function actionColours(kind: 'primary' | 'secondary' | 'dismiss'): { readonly background: string; readonly label: string } {
  return kind === 'primary' ? { background: palette.accent, label: palette.ground } : { background: palette.ground, label: palette.ink };
}
