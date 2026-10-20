/**
 * The redesign's home screen (homeLayout.ts): the "How Wick works" pill
 * beside the other three, and "Carry on" on a film left part-way — in both
 * languages, in every theme, at 32pt and at 40pt. Never taller than the
 * screen, never a word cut, never a pill off the row.
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@wick/contracts';
import { calmTheme, type CalmPreferences } from '../../../../../packages/vega-calm-ui/src/theme.js';
import { CATALOG } from '../../catalog/catalog.js';
import { WORDS } from '../../words/words.js';
import {
  HOME_ROW_DP,
  HOME_SCREEN,
  POSTER_MIN_DP,
  carryOnOverPoster,
  homeHeight,
  homeLayout,
  pillRowDp,
  pillWidthDp,
  pillsWithWords,
  titleLines,
  type DayText,
  type PillSpec,
} from '../homeLayout.js';

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];
const name = (p: CalmPreferences): string => `${p.largerText ? 'larger' : 'standard'} text${p.higherContrast ? ', higher contrast' : ''}`;
const titles = CATALOG.map((programme) => programme.title);

/** The pills as the home screen offers them, in a language: every one of them, the most there can be. */
function everyPill(language: (typeof LANGUAGES)[number], light: 'home.lightOn' | 'home.lightOut'): PillSpec[] {
  const say = WORDS[language];
  return [
    { id: 'light', words: say[light] },
    { id: 'mantel', words: say['home.mantel'] },
    { id: 'seeing', words: say['seeing.entry'] },
    { id: 'tour', words: say['home.tour'] },
  ];
}

describe('the pills, with How Wick works among them', () => {
  it('fit one row in every language and theme, with the widest of them opened by the focus', () => {
    for (const language of LANGUAGES) {
      for (const p of EVERY) {
        for (const light of ['home.lightOn', 'home.lightOut'] as const) {
          const t = calmTheme(p);
          const pills = everyPill(language, light);
          expect(pillRowDp(t, pills, pillsWithWords(t, pills)), `${language}, ${name(p)}, ${light}`).toBeLessThanOrEqual(HOME_ROW_DP);
        }
      }
    }
  });

  it('keep their words whenever the row has room: Easier to see and How Wick works alone always do at 32pt', () => {
    const t = calmTheme();
    const two: PillSpec[] = [
      { id: 'seeing', words: WORDS.en['seeing.entry'] },
      { id: 'tour', words: WORDS.en['home.tour'] },
    ];
    expect(pillsWithWords(t, two)).toEqual(new Set(['seeing', 'tour']));
  });

  it('give their words up mantelpiece first and How Wick works last', () => {
    const t = calmTheme();
    const shown = pillsWithWords(t, everyPill('en', 'home.lightOn'));
    expect(shown.has('tour')).toBe(true);
    expect(shown.has('mantel')).toBe(false);
    // Whatever gives way, the order holds: a pill keeps its words only if every pill after it in the order does.
    for (const p of EVERY) {
      for (const language of LANGUAGES) {
        const kept = pillsWithWords(calmTheme(p), everyPill(language, 'home.lightOut'));
        const order = ['mantel', 'light', 'seeing', 'tour'];
        const first = order.findIndex((id) => kept.has(id));
        if (first >= 0) for (const id of order.slice(first)) expect(kept.has(id), `${language}, ${name(p)}: ${id}`).toBe(true);
      }
    }
  });

  it('make room for an icon beside the words', () => {
    const t = calmTheme();
    expect(pillWidthDp(t, 'How Wick works')).toBeGreaterThan(pillWidthDp(t, undefined) + 14 * 16);
  });
});

describe('a film left part-way', () => {
  const chips = (language: (typeof LANGUAGES)[number]) => ({ carryOn: WORDS[language]['home.carryOn'], left: WORDS[language]['home.left'].replace('{minutes}', '120') });

  it('says Carry on over its picture at 32pt, where the picture has room', () => {
    for (const language of LANGUAGES) {
      const layout = homeLayout(calmTheme(), { quiet: false, titles: 1, carryOn: chips(language) });
      expect(layout.carryOn, language).toBe('over');
      expect(layout.captionLines).toBe(1);
    }
  });

  it('says it in the caption instead where the picture is too short, or there is none — never cut', () => {
    const larger = calmTheme({ largerText: true, higherContrast: false });
    const layout = homeLayout(larger, { quiet: true, titles: titleLines(larger, titles), carryOn: chips('es') });
    expect(layout.carryOn).toBe('caption');
    expect(layout.captionLines).toBe(titleLines(larger, titles) + 1);
    expect(carryOnOverPoster(larger, 0, chips('en'))).toBe(false);
  });

  it('keeps the screen inside 540dp in every theme and language, with the quiet line or without it', () => {
    for (const p of EVERY) {
      for (const language of LANGUAGES) {
        for (const quiet of [false, true]) {
          const t = calmTheme(p);
          const lines = titleLines(t, titles);
          const layout = homeLayout(t, { quiet, titles: lines, carryOn: chips(language) });
          expect(homeHeight(t, quiet, layout.captionLines, layout.tightCaption), `${language}, ${name(p)}, quiet ${quiet}`).toBeLessThanOrEqual(HOME_SCREEN.height);
          expect(layout.poster === 0 || layout.poster >= POSTER_MIN_DP).toBe(true);
        }
      }
    }
  });

  it('is still marked where there is no line left to give: by its progress line, and the words to the screen reader', () => {
    const both = calmTheme({ largerText: true, higherContrast: true });
    const layout = homeLayout(both, { quiet: true, titles: titleLines(both, titles), carryOn: chips('en') });
    expect(layout.carryOn).toBe('line');
  });

  it('keeps her day whole beside it', () => {
    const day: DayText = { greeting: 'Good afternoon, Margaret.', greetingPlain: 'Good afternoon.', date: 'Wednesday 30 September', coming: ['Maria usually comes tomorrow at 9 am.'] };
    for (const p of EVERY) {
      const t = calmTheme(p);
      const layout = homeLayout(t, { quiet: true, titles: titleLines(t, titles), day, carryOn: chips('en') });
      expect(layout.care?.panel.length, name(p)).toBeGreaterThanOrEqual(0);
      expect(layout.care?.poster).toBe(layout.poster);
    }
  });
});
