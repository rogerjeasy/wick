/**
 * Her day, at the top of her home screen (packages/contracts/src/today.ts).
 *
 * The home screen opens on her, not on a question about films: "Good
 * morning, Margaret.", the date, and who is coming — the lines the server
 * wrote, already in her language. This file says those words, and decides
 * when the television should ask for her day again. The layout is
 * homeLayout.ts's; the drawing is HomeScreen.tsx's on Vega and Fire OS, and
 * tv.js's in a browser tab, which is given this same file (`npm run
 * tv:build`).
 *
 * The television's own clock is used only to count time from the start of
 * her day as the server said it (contracts dayToShow) — never to know what
 * day it is: the Vega Virtual Device's clock runs in UTC.
 *
 * Pure, and imports nothing of the platform.
 */
import { dayIsOver, dayToShow, type HerDay, type HouseholdLanguage, type PartOfDay } from '@wick/contracts';
import { words, type WordKey } from '../words/words.js';

/** What the home screen says of her day now, in her language. */
export interface HomeDay {
  /** "Good morning, Margaret." — or without her name when the household has none. */
  readonly greeting: string;
  /** "Good morning." — for when the greeting with her name and the date do not fit one row. */
  readonly greetingPlain: string;
  /** "Monday 19 October". */
  readonly date: string;
  /** Who is coming, in the order it happens: the server's sentences, each whole. */
  readonly coming: readonly string[];
}

const GREETING: Readonly<Record<PartOfDay, readonly [named: WordKey, plain: WordKey]>> = {
  morning: ['home.greetMorning', 'home.greetMorningPlain'],
  afternoon: ['home.greetAfternoon', 'home.greetAfternoonPlain'],
  evening: ['home.greetEvening', 'home.greetEveningPlain'],
};

const dayKey = (weekday: number): WordKey => `day.${weekday}` as WordKey;
const monthKey = (month: number): WordKey => `month.${month}` as WordKey;

/**
 * Her day in words, as of `now` — or undefined when the server has not
 * said one, or the one it said is over (then the home screen is as it was,
 * and the television asks again: herDayAsker).
 */
export function homeDay(today: HerDay | undefined, now: number, language: HouseholdLanguage): HomeDay | undefined {
  const shown = dayToShow(today, now);
  if (!today || !shown) return undefined;
  const say = words(language);
  const [named, plain] = GREETING[shown.part];
  // The keys are named by the part of the day; a key that names a value is given it, one that does not, nothing.
  const put = (key: WordKey, values: Readonly<Record<string, string | number>>): string => (say as (k: WordKey, v?: Readonly<Record<string, string | number>>) => string)(key, values);
  const plainGreeting = put(plain, {});
  return {
    greeting: today.name ? put(named, { name: today.name }) : plainGreeting,
    greetingPlain: plainGreeting,
    date: put('home.date', { weekday: put(dayKey(today.weekday), {}), day: today.day, month: put(monthKey(today.month), {}) }),
    coming: shown.coming.map((c) => c.line),
  };
}

/** Two days told the same: nothing on the home screen need be drawn again. */
export function sameHomeDay(a: HomeDay | undefined, b: HomeDay | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.greeting === b.greeting && a.greetingPlain === b.greetingPlain && a.date === b.date && a.coming.length === b.coming.length && a.coming.every((line, i) => line === b.coming[i]);
}

/** Asked for again at the latest this often while Wick is on screen: a visitor added from the family app sends no card. */
export const HER_DAY_ASK_EVERY_MS = 30 * 60_000;
/** A card that has just come may be about a visit just arranged: her day is asked for this long after, once the roster has it. */
export const HER_DAY_AFTER_CARD_MS = 3_000;
/** While the day she was told is over and no new one has come, asked for again no more often than this. */
export const HER_DAY_RETRY_MS = 60_000;

/**
 * When the television asks for her day (`{ t: 'home' }`, contracts
 * device.ts): when the day it was told is over, a little after a card it
 * had not seen comes, and now and then while it is on screen. Never while
 * Wick is behind another app — nobody would see it — and never for a
 * server that says no day at all.
 *
 * The first look only learns what is there: the channel has just been told
 * the whole home on connecting.
 */
export function herDayAsker(): { look(input: { readonly now: number; readonly today: HerDay | undefined; readonly cardIds: readonly string[]; readonly onScreen: boolean }): boolean } {
  let seen: Set<string> | undefined;
  let lastAskedAt: number | undefined;
  let newCardAt: number | undefined;
  return {
    look({ now, today, cardIds, onScreen }) {
      if (seen !== undefined && cardIds.some((id) => !seen!.has(id))) newCardAt ??= now;
      seen = new Set(cardIds);
      if (lastAskedAt === undefined) {
        lastAskedAt = now;
        return false;
      }
      if (!onScreen || today === undefined) return false;
      const since = now - lastAskedAt;
      const due =
        (dayIsOver(today, now) && since >= HER_DAY_RETRY_MS) ||
        (newCardAt !== undefined && now - newCardAt >= HER_DAY_AFTER_CARD_MS) ||
        since >= HER_DAY_ASK_EVERY_MS;
      if (!due) return false;
      lastAskedAt = now;
      newCardAt = undefined;
      return true;
    },
  };
}
