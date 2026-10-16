/**
 * The home screen's rows, and why each pill is where it is
 * (home/homeLayout.ts; home/HomeScreen.tsx).
 *
 * Four rows on a 960x540dp screen: the question, the films, the quiet line
 * when there is one, and the pills — her light, her mantelpiece, Easier to
 * see. The pills had other places once: the light beside the question, the
 * mantelpiece at the end of the quiet line. With larger text on (40pt, and
 * a 60pt question) neither place has room for a pill at all, and the
 * question and a waiting line are not what should be cut. So they have a
 * row of their own, in every theme, and stay where she learnt them when
 * she turns larger text on.
 *
 * Widths are worked out from the length of the words and the size they are
 * set at, at 0.47 of the type size a letter: what the question measures in
 * a plain sans-serif (648dp at 48pt). It is an estimate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@wick/contracts';
import { calmTheme, type CalmPreferences } from '../../../../../packages/vega-calm-ui/src/theme.js';
import { WORDS } from '../../words/words.js';
import { CATALOG } from '../../catalog/catalog.js';
import { HOME_RING_DP, HOME_ROW_DP, titleWidthDp, HOME_SCREEN, PILL_PADDING, POSTER_MAX_DP, POSTER_MIN_DP, QUIET_PADDING, homeHeight, homeHeights, titleLines } from '../homeLayout.js';

const GLYPH = 0.47;
const GAP_DP = HOME_SCREEN.gap;

const EVERY: readonly CalmPreferences[] = [
  { largerText: false, higherContrast: false },
  { largerText: true, higherContrast: false },
  { largerText: false, higherContrast: true },
  { largerText: true, higherContrast: true },
];
const name = (p: CalmPreferences): string => `${p.largerText ? 'larger' : 'standard'} text${p.higherContrast ? ', higher contrast' : ''}`;

const text = (words: string, pt: number): number => words.length * pt * GLYPH;

describe('the screen’s height, in every theme', () => {
  const titles = CATALOG.map((programme) => programme.title);

  it('is never more than the screen, with the quiet line or without it', () => {
    for (const p of EVERY) {
      const t = calmTheme(p);
      for (const quiet of [false, true]) expect(homeHeight(t, quiet, titleLines(t, titles)), `${name(p)}, quiet line ${quiet}`).toBeLessThanOrEqual(HOME_SCREEN.height);
    }
  });

  it('gives the films’ pictures what is left, never more than 200dp — and none at all rather than a sliver', () => {
    for (const p of EVERY) {
      for (const quiet of [false, true]) {
        const t = calmTheme(p);
        const poster = homeHeights(t, quiet, titleLines(t, titles)).poster;
        expect(poster, `${name(p)}, quiet line ${quiet}`).toBeLessThanOrEqual(POSTER_MAX_DP);
        expect(poster === 0 || poster >= POSTER_MIN_DP, `${name(p)}, quiet line ${quiet}: ${poster}`).toBe(true);
      }
    }
    // At the floor the films always have their pictures.
    expect(homeHeights(calmTheme(), true, titleLines(calmTheme(), titles)).poster).toBeGreaterThanOrEqual(POSTER_MIN_DP);
  });

  it('never cuts a film’s title: one line at 32pt, two at 40pt, where "Big Buck Bunny" is wider than a tile', () => {
    expect(titleLines(calmTheme(), titles)).toBe(1);
    expect(titleLines(calmTheme({ largerText: true, higherContrast: false }), titles)).toBe(2);
    expect(titleLines(calmTheme({ largerText: true, higherContrast: false }), ['Sintel'])).toBe(1);
  });

  it('gives a title the same width with higher contrast on: the thicker ring comes out of the padding, not the words', () => {
    expect(titleWidthDp(calmTheme({ largerText: false, higherContrast: true }))).toBe(titleWidthDp(calmTheme()));
    expect(titleLines(calmTheme({ largerText: false, higherContrast: true }), titles)).toBe(1);
  });

  it('makes the pictures shorter with larger text on, and never the words smaller', () => {
    const standard = homeHeights(calmTheme({ largerText: false, higherContrast: false }), false);
    const larger = homeHeights(calmTheme({ largerText: true, higherContrast: false }), false, 2);
    expect(larger.poster).toBeLessThan(standard.poster);
    expect(larger.pills).toBeGreaterThan(standard.pills);
    expect(larger.question).toBeGreaterThan(standard.question);
  });

  it('counts the thicker ring with higher contrast on', () => {
    const standard = homeHeights(calmTheme({ largerText: false, higherContrast: false }), true);
    const high = homeHeights(calmTheme({ largerText: false, higherContrast: true }), true);
    expect(high.pills - standard.pills).toBe(2 * (calmTheme({ largerText: false, higherContrast: true }).ring(HOME_RING_DP).footprintDp - HOME_RING_DP));
  });
});

describe('the rows’ widths', () => {
  it('holds the question alone on its line, whole, at 48pt and at 60pt', () => {
    for (const language of LANGUAGES) {
      for (const p of EVERY) expect(text(WORDS[language]['home.question'], calmTheme(p).fontSize('headline')), `${language}, ${name(p)}`).toBeLessThanOrEqual(HOME_ROW_DP);
    }
  });

  it('has no room beside the question at 60pt for even the light’s pill: that is why the pills have a row', () => {
    const t = calmTheme({ largerText: true, higherContrast: false });
    const pill = (words: string): number => text(words, t.fontSize('body')) + 2 * PILL_PADDING.horizontal + 2 * HOME_RING_DP;
    expect(text(WORDS.en['home.question'], 60) + GAP_DP + pill(WORDS.en['home.lightOn'])).toBeGreaterThan(HOME_ROW_DP);
  });

  it('holds all three pills, whole, in one row — in both languages, in every theme', () => {
    for (const language of LANGUAGES) {
      const say = WORDS[language];
      for (const p of EVERY) {
        const t = calmTheme(p);
        const pill = (words: string): number => text(words, t.fontSize('body')) + 2 * PILL_PADDING.horizontal + 2 * t.ring(HOME_RING_DP).footprintDp;
        for (const light of [say['home.lightOn'], say['home.lightOut']]) {
          const row = pill(light) + GAP_DP + pill(say['home.mantel']) + GAP_DP + pill(say['seeing.entry']);
          expect(row, `${language}, ${name(p)}: ${light}`).toBeLessThanOrEqual(HOME_ROW_DP);
        }
      }
    }
  });

  it('holds a note’s waiting line and "Open", whole, in the quiet line — at 32pt and at 40pt', () => {
    for (const language of LANGUAGES) {
      const say = WORDS[language];
      const line = say['waiting.note'].replace('{name}', 'Sarah');
      for (const p of EVERY) {
        const t = calmTheme(p);
        const row = text(line, t.fontSize('body')) + GAP_DP + text(say['home.open'], t.fontSize('body')) + 2 * QUIET_PADDING.horizontal + 2 * t.ring(HOME_RING_DP).footprintDp;
        expect(row, `${language}, ${name(p)}`).toBeLessThanOrEqual(HOME_ROW_DP);
      }
    }
  });
});

describe('HomeScreen.tsx — the pills, as drawn', () => {
  const screen = readFileSync(fileURLToPath(new URL('../HomeScreen.tsx', import.meta.url)), 'utf8');
  const titleRow = screen.slice(screen.indexOf('<View style={styles.top}>'), screen.indexOf('<View style={styles.row}>'));
  const quietRow = screen.slice(screen.indexOf('<View style={styles.quietRow}>'), screen.indexOf('<View style={styles.pills}>'));
  const pills = screen.slice(screen.indexOf('<View style={styles.pills}>'));

  it('has the question alone in the title row, and the pills in their own row', () => {
    expect(titleRow).toMatch(/home\.question/);
    expect(titleRow).not.toMatch(/<Pressable|onOpenLight|onOpenMantel|onOpenSeeing/);
    expect(quietRow).not.toMatch(/onOpenLight|onOpenMantel|onOpenSeeing/);
    expect(pills.indexOf('press(onOpenLight)')).toBeGreaterThan(-1);
    expect(pills.indexOf('press(onOpenLight)')).toBeLessThan(pills.indexOf('press(onOpenMantel)'));
    expect(pills.indexOf('press(onOpenMantel)')).toBeLessThan(pills.indexOf('press(onOpenSeeing)'));
  });

  it('has the mantelpiece only when she has kept something, and Easier to see always', () => {
    expect(pills).toMatch(/\{mantel \? \(/);
    expect(pills).toMatch(/\{seeing\}/);
    expect(pills.slice(pills.indexOf('Easier to see'))).not.toMatch(/\{seeing \? \(/);
  });

  it('shortens the films’ pictures for the quiet line, and for nothing else', () => {
    expect(screen).toMatch(/const row = waiting !== undefined \|\| quiet !== undefined;/);
    expect(screen).toMatch(/row \? styles\.posterWithRow : null/);
    expect(screen).toMatch(/height: heights\.poster,/);
    expect(screen).toMatch(/height: withRow\.poster,/);
  });

  it('is never where the focus starts: that is a film', () => {
    expect(screen).toMatch(/const start = `programme:\$\{lastWatchedId \?\? programmes\[0\]\?\.id\}`;/);
  });

  it('says each pill in words to someone who cannot see it', () => {
    expect(pills).toMatch(/accessibilityLabel=\{say\('home\.mantelLabel'\)\}/);
    expect(pills).toMatch(/accessibilityLabel=\{say\('seeing\.entryLabel'\)\}/);
    expect(pills).toMatch(/accessibilityLabel=\{say\('home\.lightLabel', \{ light \}\)\}/);
  });

  it('gives every button on the home screen the hold for Sarah — the pills too', () => {
    const pressables = screen.match(/<Pressable\b[\s\S]*?>\n/g) ?? [];

    expect(pressables).toHaveLength(5);
    for (const pressable of pressables) {
      expect(pressable).toMatch(/onLongPress=\{onHold\}/);
      expect(pressable).toMatch(/delayLongPress=\{HOLD_MS\}/);
      expect(pressable).toMatch(/onPressOut=\{pressOut\}/);
      expect(pressable).toMatch(/focusable=\{!cardVisible\}/);
    }
  });

  it('remembers where the focus was, and gives it back there when the remote is the home screen’s again', () => {
    expect(screen).toMatch(/onFocus=\{\(\) => reportFocus\(/);
    expect(screen).toMatch(/hasTVPreferredFocus=\{!cardVisible && preferred === /);
  });

  it('draws every ring from the theme: thicker with higher contrast on, and the same room at rest', () => {
    expect(screen).toMatch(/const ring = t\.ring\(HOME_RING_DP\);/);
    expect(screen.match(/on \? styles\.ringOn : styles\.ringOff/g)?.length).toBe(5);
  });
});
