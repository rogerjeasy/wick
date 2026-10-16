/**
 * The four themes — the floor, larger text, higher contrast, and both —
 * and the arithmetic under them: sizes, computed contrast ratios, the
 * focus ring, and how a card fits the screen at larger text.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../constraints.js';
import {
  GLYPH_WIDTH_EM,
  STANDARD_PREFERENCES,
  calmTheme,
  checkTheme,
  estimatedActionRows,
  estimatedLines,
  fitCard,
  stylesFor,
  textPairs,
  type CalmPreferences,
  type CalmTheme,
} from '../theme.js';
import { highContrastPalette, layout, palette } from '../tokens.js';

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];

const name = (p: CalmPreferences): string => `${p.largerText ? 'larger text' : 'standard text'}, ${p.higherContrast ? 'higher contrast' : 'standard contrast'}`;

describe('type sizes', () => {
  it('are the tokens at the floor', () => {
    const t = calmTheme(STANDARD_PREFERENCES);
    expect([t.fontSize('body'), t.fontSize('headline'), t.fontSize('display')]).toEqual([32, 48, 64]);
  });

  it('are 1.25 times the tokens with larger text on: 40, 60 and 80pt', () => {
    const t = calmTheme({ largerText: true, higherContrast: false });
    expect([t.fontSize('body'), t.fontSize('headline'), t.fontSize('display')]).toEqual([40, 60, 80]);
    expect(t.lineHeight('body')).toBeCloseTo(40 * layout.lineHeight.body);
    expect(t.lineHeight('headline')).toBeCloseTo(60 * layout.lineHeight.headline);
  });

  it('never go under 32pt in any theme', () => {
    for (const p of EVERY) {
      for (const role of ['body', 'headline', 'display'] as const) expect(calmTheme(p).fontSize(role), name(p)).toBeGreaterThanOrEqual(32);
    }
  });

  it('do not change with contrast', () => {
    expect(calmTheme({ largerText: true, higherContrast: true }).type).toEqual(calmTheme({ largerText: true, higherContrast: false }).type);
  });
});

describe('contrast, computed for every word on every ground', () => {
  it('is at least 7:1 for every pair at standard contrast', () => {
    for (const p of EVERY.filter((q) => !q.higherContrast)) {
      for (const [fg, bg] of textPairs(calmTheme(p))) expect(contrastRatio(fg, bg), `${name(p)}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(7);
    }
  });

  it('is at least 15:1 for every pair with higher contrast on — pure black and white, 21:1', () => {
    for (const p of EVERY.filter((q) => q.higherContrast)) {
      const t = calmTheme(p);
      expect(t.minContrast).toBe(15);
      for (const [fg, bg] of textPairs(t)) {
        expect(contrastRatio(fg, bg), `${name(p)}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(15);
        expect(contrastRatio(fg, bg)).toBeCloseTo(21, 5);
      }
    }
  });

  it('uses only black and white with higher contrast on', () => {
    expect(new Set(Object.values(highContrastPalette))).toEqual(new Set(['#FFFFFF', '#000000']));
    expect(calmTheme({ largerText: false, higherContrast: true }).palette).toBe(highContrastPalette);
    expect(calmTheme(STANDARD_PREFERENCES).palette).toBe(palette);
  });

  it('covers every button kind', () => {
    const pairs = textPairs(calmTheme(STANDARD_PREFERENCES));
    expect(pairs).toContainEqual([palette.ground, palette.accent]);
    expect(pairs).toContainEqual([palette.ink, palette.ground]);
  });

  it('refuses a theme that breaks its promise', () => {
    const broken: CalmTheme = { ...calmTheme({ largerText: false, higherContrast: true }), palette: { ...palette } };
    expect(() => checkTheme(broken)).toThrow(/promises 15:1/);
    const small: CalmTheme = { ...calmTheme(STANDARD_PREFERENCES), fontSize: () => 24 };
    expect(() => checkTheme(small)).toThrow(/floor/);
  });
});

describe('the focus ring', () => {
  it('is 2dp at standard contrast and 6dp with higher contrast on', () => {
    expect(calmTheme(STANDARD_PREFERENCES).ring().focused.borderWidth).toBe(2);
    expect(calmTheme({ largerText: false, higherContrast: true }).ring().focused.borderWidth).toBe(6);
  });

  it('grows by the same 4dp for a wider ring: the home screen’s 4dp tiles get 8', () => {
    expect(calmTheme({ largerText: false, higherContrast: true }).ring(4).focused.borderWidth).toBe(8);
    expect(calmTheme(STANDARD_PREFERENCES).ring(4).focused.borderWidth).toBe(4);
  });

  it('takes the same room at rest and with the focus, so moving the focus moves nothing', () => {
    for (const p of EVERY) {
      for (const width of [2, 4]) {
        const ring = calmTheme(p).ring(width);
        expect(ring.rest.borderWidth + ring.rest.margin, name(p)).toBe(ring.focused.borderWidth + ring.focused.margin);
        expect(ring.footprintDp).toBe(ring.focused.borderWidth);
      }
    }
  });

  it('outlines a button at rest only with higher contrast on, where a black button on a black card is otherwise only its words', () => {
    expect(calmTheme(STANDARD_PREFERENCES).ring().rest.borderColor).toBe('transparent');
    const high = calmTheme({ largerText: false, higherContrast: true }).ring();
    expect(high.rest.borderColor).toBe('#FFFFFF');
    expect(high.rest.borderWidth).toBeLessThan(high.focused.borderWidth);
  });
});

describe('calmTheme and stylesFor', () => {
  it('hands out the same theme for the same preferences', () => {
    expect(calmTheme({ largerText: true, higherContrast: false })).toBe(calmTheme({ largerText: true, higherContrast: false }));
    expect(calmTheme()).toBe(calmTheme(STANDARD_PREFERENCES));
  });

  it('makes a component’s styles once per theme', () => {
    let made = 0;
    const make = (t: CalmTheme) => {
      made += 1;
      return { size: t.fontSize('body') };
    };
    const larger = calmTheme({ largerText: true, higherContrast: false });
    expect(stylesFor(make, larger).size).toBe(40);
    expect(stylesFor(make, larger)).toBe(stylesFor(make, larger));
    expect(stylesFor(make, calmTheme()).size).toBe(32);
    expect(made).toBe(2);
  });
});

describe('estimatedLines', () => {
  it('wraps at spaces, at half the type size a letter', () => {
    expect(GLYPH_WIDTH_EM).toBe(0.5);
    // 160dp at 32pt is ten letters a line.
    expect(estimatedLines('', 160, 32)).toBe(0);
    expect(estimatedLines('one two', 160, 32)).toBe(1);
    expect(estimatedLines('one two three', 160, 32)).toBe(2);
    expect(estimatedLines('abcdefghijklmnopqrstu', 160, 32)).toBe(3);
  });

  it('takes more lines for the same words at 40pt than at 32', () => {
    const note = 'Hello Mum, I will ring you at six tonight after work. Love, Sarah.';
    expect(estimatedLines(note, 800, 40)).toBeGreaterThanOrEqual(estimatedLines(note, 800, 32));
  });
});

describe('estimatedActionRows', () => {
  it('puts three short buttons in one row, and wraps the door’s three at 40pt', () => {
    const standard = calmTheme(STANDARD_PREFERENCES);
    const larger = calmTheme({ largerText: true, higherContrast: false });
    expect(estimatedActionRows(['Yes', 'No', 'Back'], 816, larger)).toBe(1);
    expect(estimatedActionRows(['Keep it', 'Thank you'], 816, standard)).toBe(1);
    expect(estimatedActionRows(['Watch live', 'Ring the hallway chime', 'Not now'], 816, larger)).toBe(2);
    expect(estimatedActionRows([], 816, larger)).toBe(0);
  });
});

describe('fitCard', () => {
  const larger = calmTheme({ largerText: true, higherContrast: false });
  const base = { headline: 'Your week.', passages: [] as string[], actionLabels: ['Thank you'] };

  it('changes nothing at the floor', () => {
    const t = calmTheme(STANDARD_PREFERENCES);
    expect(fitCard({ ...base, passages: ['x '.repeat(200)] }, t)).toEqual({ theme: t, detailLines: 5 });
    expect(fitCard({ ...base, detailLines: 6, compact: true }, t).detailLines).toBe(6);
  });

  it('keeps a card whose words fit at 40pt large', () => {
    const fit = fitCard({ ...base, passages: ['You watched three films this week and Sarah looked in twice.'] }, larger);
    expect(fit.theme).toBe(larger);
    expect(fit.detailLines).toBeGreaterThanOrEqual(2);
  });

  it('draws a card at the standard size when 240 characters would not be whole at 40pt', () => {
    const fit = fitCard({ ...base, passages: ['word '.repeat(48).trim()] }, larger);
    expect(fit.theme).toBe(calmTheme(STANDARD_PREFERENCES));
    expect(fit.detailLines).toBe(5);
  });

  it('keeps higher contrast when it falls back', () => {
    const both = calmTheme({ largerText: true, higherContrast: true });
    expect(fitCard({ ...base, passages: ['word '.repeat(48).trim()] }, both).theme).toBe(calmTheme({ largerText: false, higherContrast: true }));
  });

  it('falls back for a picture too tall to stand beside 40pt words and their buttons', () => {
    const fit = fitCard({ ...base, compact: true, mediaHeightDp: 320, mediaWidthDp: 432, actionLabels: ['Keep it', 'Thank you'] }, larger);
    expect(fit.theme.preferences.largerText).toBe(false);
  });

  it('keeps the door card large with three actions and a short description', () => {
    const fit = fitCard(
      {
        headline: 'Maria is at the door.',
        compact: true,
        mediaWidthDp: 256,
        mediaHeightDp: 144,
        passages: ['A woman in a blue coat.'],
        reservedLines: 2,
        actionLabels: ['Watch live', 'Ring the hallway chime', 'Not now'],
      },
      larger,
    );
    expect(fit.theme).toBe(larger);
  });

  it('never asks a card to show more lines than it asked for', () => {
    expect(fitCard({ ...base, detailLines: 2, passages: ['Short.'] }, larger).detailLines).toBeLessThanOrEqual(2);
  });
});
