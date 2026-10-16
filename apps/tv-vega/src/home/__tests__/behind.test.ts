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
 * app can be in; HomeScreen.test.tsx draws the screen with a card up and
 * finds nothing of it there; and ResidentApp.tsx is read as source below,
 * for the answer it hands the screen.
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
