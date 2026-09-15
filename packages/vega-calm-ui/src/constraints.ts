/**
 * The accessibility floor, as functions rather than review comments.
 *
 * docs/WICK.md Part 5 lists these as principles. A principle you can only
 * remember is one you will eventually forget at 2am before a deadline, so each
 * one here is a call that throws. The components below cannot render a card
 * that breaks them.
 */
import { limits, palette, type } from './tokens.js';

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

/** Principle 6 again, for the Day Card's items. */
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
