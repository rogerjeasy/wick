/**
 * Where the mantelpiece's pill goes on the home screen, and why
 * (packages/contracts mantel.ts; home/HomeScreen.tsx).
 *
 * The home screen has three rows and no height to spare, and its title row
 * already holds one pill beside the question. A second pill there does not
 * fit at 32pt — in English by a long way, in Spanish by a little or only
 * just, the numbers are below — so the mantelpiece's pill stands at the right-hand end of the quiet row under
 * the films, and the title row is as it was.
 *
 * Widths are worked out from the length of the words and the size they are
 * set at, at 0.47 of the type size a letter: what the question measures in
 * a plain sans-serif (648dp at 48pt). It is an estimate, and it is not
 * close: the title row is over by a quarter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES } from '@wick/contracts';
import { WORDS } from '../../words/words.js';

const GLYPH = 0.47;
/** 960dp less the home screen's 48dp either side. */
const ROW_DP = 864;
const GAP_DP = 24;
/** A pill's own padding and border either side of its words (HomeScreen `light`, `pill`). */
const PILL_CHROME_DP = 2 * 16 + 2 * 4;
/** The waiting row's (HomeScreen `waiting`). */
const WAITING_CHROME_DP = 2 * 20 + 2 * 4;

const text = (words: string, pt: number): number => words.length * pt * GLYPH;
const pill = (words: string): number => text(words, 32) + PILL_CHROME_DP;

describe('the title row — the question, and the light’s pill', () => {
  it('holds the question at 48pt and one pill, as it always has', () => {
    for (const language of LANGUAGES) {
      const say = WORDS[language];
      for (const light of [say['home.lightOn'], say['home.lightOut']]) {
        expect(text(say['home.question'], 48) + GAP_DP + pill(light), `${language}: ${light}`).toBeLessThanOrEqual(ROW_DP);
      }
    }
  });

  const withBoth = (language: (typeof LANGUAGES)[number], light: 'home.lightOn' | 'home.lightOut'): number => {
    const say = WORDS[language];
    return text(say['home.question'], 48) + GAP_DP + pill(say[light]) + GAP_DP + pill(say['home.mantel']);
  };

  it('has no room for a second pill at 32pt in English: not by a little, by about as much as that pill is wide', () => {
    for (const light of ['home.lightOn', 'home.lightOut'] as const) {
      expect(withBoth('en', light) - ROW_DP, light).toBeGreaterThan(pill(WORDS.en['home.mantel']) * 0.9);
    }
  });

  it('has none in Spanish either with the light on, and with it out so little to spare that a wider letter would cut the question', () => {
    expect(withBoth('es', 'home.lightOn')).toBeGreaterThan(ROW_DP);
    expect(ROW_DP - withBoth('es', 'home.lightOut')).toBeLessThan(ROW_DP * 0.03);
  });

  it('has none for the mantelpiece’s pill alone beside the English question, either', () => {
    expect(text(WORDS.en['home.question'], 48) + GAP_DP + pill(WORDS.en['home.mantel'])).toBeGreaterThan(ROW_DP);
  });
});

describe('the quiet row under the films — where the mantelpiece’s pill stands', () => {
  it('has room for who looked in and the pill, whole, in both languages', () => {
    const looked = { en: 'Sarah looked in this afternoon.', es: 'Sarah se asomó esta tarde.' };
    for (const language of LANGUAGES) {
      expect(text(looked[language], 32) + WAITING_CHROME_DP + GAP_DP + pill(WORDS[language]['home.mantel']), language).toBeLessThanOrEqual(ROW_DP);
    }
  });

  it('has room for a note’s waiting line, "Open" and the pill, whole', () => {
    for (const language of LANGUAGES) {
      const say = WORDS[language];
      const line = say['waiting.note'].replace('{name}', 'Sarah');
      const row = text(line, 32) + GAP_DP + text(say['home.open'], 32) + WAITING_CHROME_DP + GAP_DP + pill(say['home.mantel']);

      expect(row, language).toBeLessThanOrEqual(ROW_DP);
    }
  });

  it('is no taller for it: a pill is not as tall as the waiting row, so the films keep the height they have with any row', () => {
    const line = 32 * 1.4;
    const pillHeight = line + 2 * 2 + 2 * 4;
    const waitingRow = line + 2 * 6 + 2 * 4;

    expect(pillHeight).toBeLessThanOrEqual(waitingRow);
    // The screen with a row, as it is today: padding, the question, the films at the shorter poster, the row, two gaps.
    const tile = 170 + (2 * 16 + line + 4 + line) + 2 * 4;
    expect(2 * 32 + 48 * 1.25 + 24 + tile + 24 + waitingRow).toBeLessThanOrEqual(541);
  });
});

describe('HomeScreen.tsx — the pill, as drawn', () => {
  const screen = readFileSync(fileURLToPath(new URL('../HomeScreen.tsx', import.meta.url)), 'utf8');
  const titleRow = screen.slice(screen.indexOf('<View style={styles.top}>'), screen.indexOf('<View style={styles.row}>'));
  const quietRow = screen.slice(screen.indexOf('<View style={styles.quietRow}>'));

  it('is in the quiet row, not the title row', () => {
    expect(quietRow.length).toBeGreaterThan(100);
    expect(titleRow).not.toMatch(/onOpenMantel|mantel/);
    expect(quietRow).toMatch(/onPress=\{onOpenMantel\}/);
    expect(quietRow).toMatch(/\{mantel\}/);
  });

  it('is only there when she has kept something, and shortens the films’ pictures as any row does', () => {
    expect(quietRow).toMatch(/\{mantel \? \(/);
    expect(screen).toMatch(/const row = waiting !== undefined \|\| quiet !== undefined \|\| mantel !== undefined;/);
    expect(screen).toMatch(/row \? styles\.posterWithRow : null/);
  });

  it('is never where the focus starts: that is a film', () => {
    expect(screen).toMatch(/const start = `programme:\$\{lastWatchedId \?\? programmes\[0\]\?\.id\}`;/);
  });

  it('is said in words to someone who cannot see it', () => {
    expect(quietRow).toMatch(/accessibilityLabel=\{say\('home\.mantelLabel'\)\}/);
  });

  it('gives every button on the home screen the hold for Sarah — the pill too', () => {
    const pressables = screen.match(/<Pressable\b[\s\S]*?>\n/g) ?? [];

    expect(pressables).toHaveLength(4);
    for (const pressable of pressables) {
      expect(pressable).toMatch(/onLongPress=\{onHold\}/);
      expect(pressable).toMatch(/delayLongPress=\{HOLD_MS\}/);
      expect(pressable).toMatch(/onPressOut=\{onKeyUp\}/);
      expect(pressable).toMatch(/focusable=\{!cardVisible\}/);
    }
  });

  it('remembers where the focus was, and gives it back there when the remote is the home screen’s again', () => {
    expect(screen).toMatch(/onFocus=\{\(\) => \{\s*focused\.current = /);
    expect(screen).toMatch(/hasTVPreferredFocus=\{!cardVisible && preferred === /);
  });
});
