/**
 * Every step of the tour fits the screen whole, in both languages and every
 * theme: at the size she chose, or at the standard size where a step's
 * words would not all fit at 40pt — never cut, never under 32pt.
 */
import { describe, expect, it, vi } from 'vitest';
import { LANGUAGES } from '@wick/contracts';
import { calmTheme, type CalmPreferences } from '../../../../../packages/vega-calm-ui/src/theme.js';
import { words } from '../../words/words.js';
import { TOUR_STEPS, stepWords } from '../tour.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
import { TOUR_ROOM_DP, tourHeightDp, tourTheme, type TourWords } from '../tourLayout.js';

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];

describe('the tour on the screen', () => {
  it('fits every step whole, in every language and theme', () => {
    for (const language of LANGUAGES) {
      const say = words(language);
      const name = say('tour.family');
      for (const step of TOUR_STEPS) {
        const w: TourWords = stepWords(say, step, name);
        for (const p of EVERY) {
          const t = tourTheme(calmTheme(p), step.kind, w);
          expect(tourHeightDp(t, step.kind, w), `${language} ${step.kind} ${JSON.stringify(p)}`).toBeLessThanOrEqual(TOUR_ROOM_DP);
          expect(t.fontSize('body')).toBeGreaterThanOrEqual(32);
          expect(t.preferences.higherContrast).toBe(p.higherContrast);
        }
      }
    }
  });

  it('keeps the size she chose wherever the step has room for it', () => {
    const say = words('en');
    const done = TOUR_STEPS.find((step) => step.kind === 'done')!;
    const w: TourWords = stepWords(say, done, say('tour.family'));
    expect(tourTheme(calmTheme({ largerText: true, higherContrast: false }), 'done', w).fontSize('body')).toBe(40);
  });
});
