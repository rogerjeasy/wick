/**
 * The home screen behind a card: while a card is on screen over the home,
 * nothing of the home screen is partly visible.
 *
 * A card stands at the bottom of the screen and is as tall as its words, so
 * a card of a certain height ended exactly across the home's title row: the
 * question and the light's pill were sliced in half by the card's top edge,
 * and on a shorter card the tops of the films showed above it. The home's
 * rows are now left out whole while a card shows — the card is alone on the
 * ground colour — and come back, with the focus where it was, when it goes.
 *
 * The rule is `homeBehind` (home/behind.ts), tested here in every state the
 * app can be in; and HomeScreen.tsx is read as source, so a row drawn while
 * a card is showing fails here and not on a television.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDLE_OFF, type Idle } from '../../mantel/idle.js';
import { homeBehind } from '../behind.js';

const IDLE: Record<string, Idle> = {
  off: IDLE_OFF,
  on: { phase: 'on', startedAt: 1 },
  ending: { phase: 'ending', key: 'enter', at: 1 },
};
const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('homeBehind — what of the home screen is drawn, and whether the remote can reach it', () => {
  it('draws every row and gives them the remote when nothing is over the home', () => {
    expect(homeBehind({ card: false, mantelOpen: false, idle: IDLE_OFF })).toEqual({ rows: true, reach: true });
  });

  it('leaves the rows out whole while a card is on screen — in every state the rest of the app can be in', () => {
    for (const mantelOpen of [false, true]) {
      for (const idle of Object.values(IDLE)) {
        expect(homeBehind({ card: true, mantelOpen, idle }), `${mantelOpen} ${idle.phase}`).toEqual({ rows: false, reach: false });
      }
    }
  });

  it('never gives the remote to rows that are not drawn', () => {
    for (const card of [false, true]) {
      for (const mantelOpen of [false, true]) {
        for (const idle of Object.values(IDLE)) {
          const home = homeBehind({ card, mantelOpen, idle });
          expect(home.reach && !home.rows, `${card} ${mantelOpen} ${idle.phase}`).toBe(false);
        }
      }
    }
  });

  it('keeps the rows, out of the remote’s reach, under her mantelpiece and under her pictures: those cover the screen whole', () => {
    expect(homeBehind({ card: false, mantelOpen: true, idle: IDLE_OFF })).toEqual({ rows: true, reach: false });
    expect(homeBehind({ card: false, mantelOpen: false, idle: IDLE.on! })).toEqual({ rows: true, reach: false });
  });

  it('shows the home again the moment a key ends the idle screen — still out of reach until that key has come up', () => {
    expect(homeBehind({ card: false, mantelOpen: false, idle: IDLE.ending! })).toEqual({ rows: true, reach: false });
  });
});

describe('HomeScreen.tsx — nothing of it is drawn behind a card', () => {
  const screen = code('../HomeScreen.tsx');
  const body = screen.slice(screen.indexOf('export function HomeScreen('), screen.indexOf('const styles = StyleSheet.create('));
  const leftOut = body.indexOf('if (!drawn) return <View style={styles.screen} />;');

  it('draws only its own ground while a card is showing: an empty view, and nothing in it', () => {
    expect(leftOut).toBeGreaterThan(-1);
  });

  it('draws no row, no word and no picture before that — everything it has comes after', () => {
    const before = body.slice(0, leftOut);
    const after = body.slice(leftOut);

    expect(before).not.toMatch(/<(Text|Image|Pressable)\b/);
    expect(before).not.toMatch(/styles\.(top|row|quietRow|tile|light|waiting)\b/);
    for (const row of ['styles.top', 'styles.row', 'styles.quietRow']) expect(after, row).toContain(row);
    // One way out with rows in it, and it is the last.
    expect(body.match(/\breturn\b[^;]*</g)).toHaveLength(2);
  });

  it('stands on the ground colour, so the card is alone on it', () => {
    expect(read('../HomeScreen.tsx')).toMatch(/screen: \{\s*flex: 1,\s*backgroundColor: t\.palette\.ground,/);
  });

  it('still remembers where the focus was while its rows are out: the memory is kept before they are left out', () => {
    expect(body.indexOf('const focus = React.useRef')).toBeGreaterThan(-1);
    expect(body.indexOf('const focus = React.useRef')).toBeLessThan(leftOut);
    // And it is told that the rows have gone out of reach before they are left out.
    expect(body.indexOf('focus.current = reachChanged(')).toBeLessThan(leftOut);
    expect(body.slice(leftOut)).toMatch(/hasTVPreferredFocus=\{!cardVisible && preferred === /);
  });

  it('calls no hook after the rows are left out', () => {
    expect(body.slice(leftOut)).not.toMatch(/React\.use[A-Z]|\buse[A-Z]\w*\(/);
  });
});

describe('ResidentApp.tsx — the home behind a card, in the app', () => {
  const app = code('../../ResidentApp.tsx');

  it('asks the one rule, with the card that is on screen', () => {
    // The Easier to see card is a card like any other here: the home's rows are not drawn behind it.
    expect(app).toMatch(/const behind = homeBehind\(\{ card: card !== null \|\| seeingShown, mantelOpen, idle \}\);/);
  });

  it('gives the home screen both answers, and nothing of its own making', () => {
    const home = app.slice(app.indexOf('<HomeScreen'), app.indexOf('/>', app.indexOf('<HomeScreen')));

    expect(home).toMatch(/drawn=\{behind\.rows\}/);
    expect(home).toMatch(/cardVisible=\{!behind\.reach\}/);
    expect(home).not.toMatch(/card !== null|mantelOpen|blocksHome/);
  });

  it('leaves a film as it was: the film stays in view behind a card', () => {
    const film = app.slice(app.indexOf('<WatchScreen'), app.indexOf('/>', app.indexOf('<WatchScreen')));

    expect(film).not.toMatch(/drawn=|behind\./);
    expect(film).toMatch(/cardVisible=\{card !== null\}/);
  });
});
