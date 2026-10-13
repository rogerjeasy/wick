/**
 * The question about her language is asked in both languages at once, so
 * its detail is the longest a card carries — up to 240 characters — and
 * all of it has to be read: the half that is cut off may be the half she
 * can read. LanguageCard.tsx itself has no test (it is a view, like the
 * others); what it is drawn with is decided in languageDetail.ts and held
 * here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, MAX_CARD_DETAIL_CHARS, languageQuestion, type HouseholdLanguage } from '@wick/contracts';
// By path: the package's index brings the components in, and with them the platform.
import { assertCardFits, cardHeightDp } from '../../../../../packages/vega-calm-ui/src/constraints.js';
import { layout, limits, type } from '../../../../../packages/vega-calm-ui/src/tokens.js';
import { LANGUAGE_CARD_COMPACT, LANGUAGE_DETAIL_LINES } from '../languageDetail.js';

/** The card layer's padding either side (ResidentApp.tsx `cardLayer`), on Vega's 960dp-wide screen. */
const SCREEN_WIDTH_DP = 960;
const CARD_LAYER_PADDING_DP = 48;
/** Wider than text really is: a line of prose averages under half its type size a letter. */
const GLYPH_WIDTH = 0.55;

const charsPerLine = (compact: boolean): number =>
  Math.floor((SCREEN_WIDTH_DP - 2 * CARD_LAYER_PADDING_DP - 2 * (compact ? layout.compactPaddingDp : layout.cardPaddingDp)) / (type.bodyPt * GLYPH_WIDTH));

/** How many lines a text takes when it is broken between words, as the screen breaks it. */
function linesOf(text: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    // A word longer than a line is broken across lines.
    const length = Math.min(word.length, perLine);
    if (used > 0 && used + 1 + length > perLine) {
      lines += 1;
      used = 0;
    }
    used += (used > 0 ? 1 : 0) + length;
    if (word.length > perLine) {
      lines += Math.ceil(word.length / perLine) - 1;
      used = word.length % perLine || perLine;
    }
  }
  return lines;
}

/** How many characters of a headline fit a line: at 48pt on an ordinary card, at body size on a compact one. */
const headlineCharsPerLine = (compact: boolean): number =>
  compact ? charsPerLine(true) : Math.floor((SCREEN_WIDTH_DP - 2 * CARD_LAYER_PADDING_DP - 2 * layout.cardPaddingDp) / (type.headlinePt * GLYPH_WIDTH));

/** The longest detail the server writes: the contract cuts a long name, never the sentence (packages/contracts language.ts). */
const longestDetail = (language: HouseholdLanguage, name: string): string => languageQuestion(language, name).detail;

/** Names long enough to be cut: one long word, and several words — lines break differently. */
const LONG_NAMES = ['M'.repeat(60), 'María de los Ángeles Fernández de la Cruz y Ortega'];

describe('the question about her language — all of it on the screen', () => {
  it('is drawn compact, with one line more than a card usually gets', () => {
    expect(LANGUAGE_CARD_COMPACT).toBe(true);
    expect(LANGUAGE_DETAIL_LINES).toBe(limits.maxDetailLines + 1);
  });

  it('still fits the screen, with its buttons, at 32pt — the rule the card itself enforces when it is drawn', () => {
    expect(() => assertCardFits({ compact: LANGUAGE_CARD_COMPACT, detailLines: LANGUAGE_DETAIL_LINES })).not.toThrow();
    expect(cardHeightDp({ compact: LANGUAGE_CARD_COMPACT, detailLines: LANGUAGE_DETAIL_LINES })).toBeLessThanOrEqual(layout.screenHeightDp - 2 * layout.screenMarginDp);
    expect(type.bodyPt).toBeGreaterThanOrEqual(32);
  });

  it('shows the whole of the longest question the server can write, in either language, whoever asks', () => {
    for (const language of LANGUAGES) {
      for (const name of [...LONG_NAMES, 'Sarah', 'Bartholomew-Alexander']) {
        const detail = longestDetail(language, name);

        expect(detail.length, detail).toBeLessThanOrEqual(MAX_CARD_DETAIL_CHARS);
        expect(linesOf(detail, charsPerLine(LANGUAGE_CARD_COMPACT)), detail).toBeLessThanOrEqual(LANGUAGE_DETAIL_LINES);
      }
    }
    // And those are long: within a line of the most a card's detail may be.
    expect(Math.max(...LANGUAGES.flatMap((language) => LONG_NAMES.map((name) => longestDetail(language, name).length)))).toBeGreaterThan(MAX_CARD_DETAIL_CHARS - charsPerLine(true));
  });

  it('shows 240 characters whole — the most a card’s detail may be — written in sentences like its own', () => {
    // The question's own sentences, in both languages, run on to the limit.
    const text = 'Solo cambia si usted dice que sí. Nothing changes unless you say yes. '.repeat(6).slice(0, MAX_CARD_DETAIL_CHARS).trim();

    expect(text.length).toBeGreaterThan(MAX_CARD_DETAIL_CHARS - 2);
    expect(linesOf(text, charsPerLine(LANGUAGE_CARD_COMPACT)), text).toBeLessThanOrEqual(LANGUAGE_DETAIL_LINES);
    // With room to spare for where the lines happen to break: six lines hold more than 240 characters.
    expect(LANGUAGE_DETAIL_LINES * charsPerLine(LANGUAGE_CARD_COMPACT)).toBeGreaterThanOrEqual(MAX_CARD_DETAIL_CHARS + LANGUAGE_DETAIL_LINES * 6);
  });

  it('could not be drawn the usual way: five lines do not hold 240 characters, and its question would take two lines at 48pt', () => {
    // The detail: five lines of an ordinary card are fewer characters than a card's detail may have.
    expect(limits.maxDetailLines * charsPerLine(false)).toBeLessThan(MAX_CARD_DETAIL_CHARS);
    // The headline: on a second line it makes the ordinary card taller than the screen has room for.
    expect(languageQuestion('es', 'Sarah').headline.length).toBeGreaterThan(headlineCharsPerLine(false));
    const secondHeadlineLine = type.headlinePt * layout.lineHeight.headline;
    expect(cardHeightDp({}) + secondHeadlineLine).toBeGreaterThan(layout.screenHeightDp - 2 * layout.screenMarginDp);
  });

  it('keeps its question on one line at the size a compact card writes it, in both languages', () => {
    for (const language of LANGUAGES) {
      expect(languageQuestion(language, 'Sarah').headline.length).toBeLessThanOrEqual(headlineCharsPerLine(true));
    }
  });

  it('is drawn by its view with exactly those two things, the server’s words, and its two buttons as they came', () => {
    const view = readFileSync(fileURLToPath(new URL('../LanguageCard.tsx', import.meta.url)), 'utf8');

    expect(view).toMatch(/<CalmCard\s+headline=\{card\.headline\}\s+detail=\{card\.detail\}\s+actions=\{card\.actions\}\s+onAction=\{onAction\}\s+compact=\{LANGUAGE_CARD_COMPACT\}\s+detailLines=\{LANGUAGE_DETAIL_LINES\}\s*\/>/);
  });
});
