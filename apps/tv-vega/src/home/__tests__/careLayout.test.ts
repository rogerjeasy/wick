/**
 * Her day on the home screen's 540dp (homeLayout.ts careLayout), in every
 * theme and both languages: never taller than the screen, never a word
 * cut, the date always somewhere, the films' pictures given up before any
 * line about who is coming, and the soonest visit never left out for a
 * later one.
 */
import { describe, expect, it } from 'vitest';
import { calmTheme, type CalmPreferences } from '../../../../../packages/vega-calm-ui/src/theme.js';
import { CATALOG } from '../../catalog/catalog.js';
import { DAY_GAP_DP, DAY_LINE_GAP_DP, DAY_PADDING, HOME_SCREEN, POSTER_MAX_DP, POSTER_MIN_DP, careLayout, dayLines, homeHeights, titleLines, type DayText } from '../homeLayout.js';

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];
const name = (p: CalmPreferences): string => `${p.largerText ? 'larger' : 'standard'} text${p.higherContrast ? ', higher contrast' : ''}`;
const titles = CATALOG.map((programme) => programme.title);

const english: DayText = {
  greeting: 'Good afternoon, Margaret.',
  greetingPlain: 'Good afternoon.',
  date: 'Wednesday 30 September',
  coming: ['The window cleaner is expected today at 10:18 am. Sarah arranged it.', 'Sarah is coming to see you today at 6 pm.', 'Maria usually comes tomorrow at 9 am.'],
};
const spanish: DayText = {
  greeting: 'Buenas tardes, Margaret.',
  greetingPlain: 'Buenas tardes.',
  date: 'Miércoles 30 de septiembre',
  coming: ['The window cleaner is expected today at 10:18 am. Sarah arranged it.', 'Sarah viene a verle hoy a las 18:00.', 'Maria suele venir mañana a las 9:00.'],
};
const quietDay: DayText = { greeting: 'Good morning, Margaret.', greetingPlain: 'Good morning.', date: 'Monday 19 October', coming: [] };

/** The whole height as drawn: the rows, the panel and the pictures. */
function drawnHeight(p: CalmPreferences, day: DayText, quiet: boolean): number {
  const t = calmTheme(p);
  const lines = titleLines(t, titles);
  const h = homeHeights(t, quiet, lines);
  const care = careLayout(t, day, quiet, lines);
  const panel = care.panel.length > 0 ? DAY_GAP_DP + care.panelHeight : 0;
  return 2 * HOME_SCREEN.paddingVertical + h.question + panel + h.tileWithoutPoster + care.poster + h.pills + h.quiet + HOME_SCREEN.gap * (quiet ? 3 : 2);
}

describe('her day on the home screen, in every theme', () => {
  it('is never taller than the screen, with the quiet row or without it, in English or in Spanish', () => {
    for (const p of EVERY) for (const day of [english, spanish, quietDay]) for (const quiet of [false, true]) {
      expect(drawnHeight(p, day, quiet), `${name(p)}, ${day.date}, quiet row ${quiet}`).toBeLessThanOrEqual(HOME_SCREEN.height);
    }
  });

  it('always says the date: beside the greeting, at the head of the panel, or as the headline itself', () => {
    for (const p of EVERY) for (const day of [english, spanish, quietDay]) for (const quiet of [false, true]) {
      const care = careLayout(calmTheme(p), day, quiet, titleLines(calmTheme(p), titles));
      const said = care.dateBeside === day.date || care.panel[0] === day.date || care.headline === day.date;
      expect(said, `${name(p)}, ${day.date}, quiet row ${quiet}`).toBe(true);
    }
  });

  it('greets her by name at the floor size, with the date beside it, and keeps the films’ pictures for a quiet day', () => {
    const care = careLayout(calmTheme(), quietDay, false, 1);
    expect(care).toMatchObject({ headline: 'Good morning, Margaret.', dateBeside: 'Monday 19 October', panel: [] });
    expect(care.poster).toBe(POSTER_MAX_DP);
  });

  it('at the floor size, a day with a visit still has the films’ pictures', () => {
    const care = careLayout(calmTheme(), { ...quietDay, coming: ['Maria usually comes tomorrow at 9 am.'] }, true, 1);
    expect(care.panel).toEqual(['Maria usually comes tomorrow at 9 am.']);
    expect(care.poster).toBeGreaterThanOrEqual(POSTER_MIN_DP);
  });

  it('gives up the pictures before any line about who is coming, and a picture is never a sliver', () => {
    for (const p of EVERY) for (const quiet of [false, true]) {
      const t = calmTheme(p);
      const lines = titleLines(t, titles);
      const care = careLayout(t, english, quiet, lines);
      expect(care.poster === 0 || care.poster >= POSTER_MIN_DP, `${name(p)}, quiet row ${quiet}: ${care.poster}`).toBe(true);
      // A line left out while there was room for a picture would be the wrong way round.
      if (care.poster > 0) expect(care.panel.filter((s) => s !== english.date)).toEqual(english.coming);
    }
  });

  it('leaves out lines from the last, never the soonest for a later one', () => {
    for (const p of EVERY) for (const quiet of [false, true]) {
      const t = calmTheme(p);
      const care = careLayout(t, english, quiet, titleLines(t, titles));
      const coming = care.panel.filter((s) => s !== english.date);
      expect(coming, name(p)).toEqual(english.coming.slice(0, coming.length));
    }
  });

  it('counts every line a sentence wraps to, at the size it is drawn', () => {
    expect(dayLines(calmTheme(), 'Maria usually comes tomorrow at 9 am.')).toBe(1);
    expect(dayLines(calmTheme(), english.coming[0]!)).toBe(2);
    expect(dayLines(calmTheme({ largerText: true, higherContrast: false }), english.coming[0]!)).toBe(2);
    for (const p of EVERY) {
      const t = calmTheme(p);
      const care = careLayout(t, english, false, titleLines(t, titles));
      const expected = care.panel.length === 0 ? 0 : 2 * DAY_PADDING.vertical + care.panelLines.reduce((a, n) => a + n, 0) * t.lineHeight('body') + (care.panel.length - 1) * DAY_LINE_GAP_DP;
      expect(care.panelHeight, name(p)).toBe(expected);
    }
  });
});
