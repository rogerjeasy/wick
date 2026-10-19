/**
 * Her day, at the top of the home screen (home/herDay.ts): the greeting and
 * the date in her words, who is coming while it is still worth saying, and
 * when the television asks for her day again.
 */
import { describe, expect, it } from 'vitest';
import type { HerDay } from '@wick/contracts';
import { HER_DAY_AFTER_CARD_MS, HER_DAY_ASK_EVERY_MS, HER_DAY_RETRY_MS, herDayAsker, homeDay, sameHomeDay } from '../herDay.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-10-18T23:00:00Z');
const END = START + 24 * HOUR;

const today: HerDay = {
  weekday: 0,
  day: 19,
  month: 9,
  name: 'Margaret',
  dayStart: START,
  dayEnd: END,
  coming: [
    { line: 'The window cleaner is expected today at 10:18 am. Sarah arranged it.', until: START + 11.3 * HOUR },
    { line: 'Maria usually comes tomorrow at 9 am.', until: END },
  ],
};

describe('homeDay — her day in her words', () => {
  it('greets her by name for the part of the day, and says the date', () => {
    expect(homeDay(today, START + 9 * HOUR, 'en')).toEqual({
      greeting: 'Good morning, Margaret.',
      greetingPlain: 'Good morning.',
      date: 'Monday 19 October',
      coming: ['The window cleaner is expected today at 10:18 am. Sarah arranged it.', 'Maria usually comes tomorrow at 9 am.'],
    });
    expect(homeDay(today, START + 14 * HOUR, 'en')?.greeting).toBe('Good afternoon, Margaret.');
    expect(homeDay(today, START + 20 * HOUR, 'en')?.greeting).toBe('Good evening, Margaret.');
  });

  it('in Spanish, to usted, with the weekday leading the date', () => {
    expect(homeDay(today, START + 9 * HOUR, 'es')).toMatchObject({ greeting: 'Buenos días, Margaret.', greetingPlain: 'Buenos días.', date: 'Lunes 19 de octubre' });
    expect(homeDay(today, START + 20 * HOUR, 'es')?.greeting).toBe('Buenas noches, Margaret.');
  });

  it('greets her without a name when the household has none', () => {
    const { name: _none, ...nameless } = today;
    expect(homeDay(nameless, START + 9 * HOUR, 'en')?.greeting).toBe('Good morning.');
  });

  it('lets a line go the moment its time is over, and the whole day at its end', () => {
    expect(homeDay(today, START + 12 * HOUR, 'en')?.coming).toEqual(['Maria usually comes tomorrow at 9 am.']);
    expect(homeDay(today, END, 'en')).toBeUndefined();
    expect(homeDay(undefined, START, 'en')).toBeUndefined();
  });

  it('knows when nothing it says has changed, so nothing is drawn again', () => {
    expect(sameHomeDay(homeDay(today, START + 9 * HOUR, 'en'), homeDay(today, START + 10 * HOUR, 'en'))).toBe(true);
    expect(sameHomeDay(homeDay(today, START + 9 * HOUR, 'en'), homeDay(today, START + 12 * HOUR, 'en'))).toBe(false);
    expect(sameHomeDay(undefined, undefined)).toBe(true);
    expect(sameHomeDay(homeDay(today, START + 9 * HOUR, 'en'), undefined)).toBe(false);
  });
});

describe('herDayAsker — when her day is asked for again', () => {
  const at = START + 9 * HOUR;

  it('not at the first look: the channel has just been told the whole home', () => {
    const asker = herDayAsker();
    expect(asker.look({ now: at, today, cardIds: [], onScreen: true })).toBe(false);
  });

  it('a little after a card it had not seen comes — it may be about a visit just arranged', () => {
    const asker = herDayAsker();
    asker.look({ now: at, today, cardIds: ['note-a'], onScreen: true });
    expect(asker.look({ now: at + 1_000, today, cardIds: ['note-a', 'note-b'], onScreen: true })).toBe(false);
    expect(asker.look({ now: at + 1_000 + HER_DAY_AFTER_CARD_MS, today, cardIds: ['note-a', 'note-b'], onScreen: true })).toBe(true);
    // Once.
    expect(asker.look({ now: at + 2_000 + HER_DAY_AFTER_CARD_MS, today, cardIds: ['note-a', 'note-b'], onScreen: true })).toBe(false);
    // A card answered and gone is not a new one.
    expect(asker.look({ now: at + 60_000, today, cardIds: ['note-a'], onScreen: true })).toBe(false);
  });

  it('when the day it was told is over — and again a minute later while no new day has come', () => {
    const asker = herDayAsker();
    asker.look({ now: END - 1_000, today, cardIds: [], onScreen: true });
    expect(asker.look({ now: END + 59_000, today, cardIds: [], onScreen: true })).toBe(true);
    expect(asker.look({ now: END + 60_000, today, cardIds: [], onScreen: true })).toBe(false);
    expect(asker.look({ now: END + 59_000 + HER_DAY_RETRY_MS, today, cardIds: [], onScreen: true })).toBe(true);
  });

  it('now and then while on screen, in case a visitor was added with no card to say so', () => {
    const asker = herDayAsker();
    asker.look({ now: at, today, cardIds: [], onScreen: true });
    expect(asker.look({ now: at + HER_DAY_ASK_EVERY_MS - 1, today, cardIds: [], onScreen: true })).toBe(false);
    expect(asker.look({ now: at + HER_DAY_ASK_EVERY_MS, today, cardIds: [], onScreen: true })).toBe(true);
  });

  it('never behind another app, and never of a server that says no day at all', () => {
    const behind = herDayAsker();
    behind.look({ now: at, today, cardIds: [], onScreen: false });
    expect(behind.look({ now: at + HER_DAY_ASK_EVERY_MS, today, cardIds: ['new'], onScreen: false })).toBe(false);
    const older = herDayAsker();
    older.look({ now: at, today: undefined, cardIds: [], onScreen: true });
    expect(older.look({ now: at + HER_DAY_ASK_EVERY_MS, today: undefined, cardIds: ['new'], onScreen: true })).toBe(false);
  });
});
