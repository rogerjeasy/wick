/**
 * The light in the window — presence, both ways.
 *
 * The family sees one thing about today: a light, lit once the resident's
 * day has begun at the television. No time, no count, no room. The resident
 * can put it out for the day, and a light that is out looks exactly like one
 * not yet lit — so an unlit window never says why.
 *
 * And it goes the other way: when someone in the family asks how the
 * resident is, the resident's own home screen says so — "Sarah looked in
 * this morning." Looking is not hidden from the person looked at.
 *
 * Nothing new is measured. The light reads what a paired television already
 * stamps when someone is at it (`activeSignalAt`, edge-device
 * television-active.mjs), plus two kinds of row in the household's table:
 *
 *   `HH#<household>` / `LIGHT`              `outAt`: when she put it out
 *   `HH#<household>` / `LOOKIN#<userId>`    `name`, `lookedAt`: that person's latest look
 */
import { DEFAULT_LANGUAGE, isHouseholdLanguage, type OtherLanguage } from './language.js';
import { MAX_MANTEL } from './mantel.js';
import { readHerDay, type HerDay } from './today.js';

export const LIGHT_SK = 'LIGHT';
export const LOOKIN_SK_PREFIX = 'LOOKIN#';

/** One card, asked for from the home screen: the same id each time, like "What Sarah sees". */
export const LIGHT_CARD_ID = 'light';

export const LIGHT_ACTIONS = {
  putOut: 'put_out',
  lightAgain: 'light_again',
  ok: 'ok',
  /** "What your family sees": the pages of what is shared, and Stop Wick at their end (edge sharing.mjs). */
  sharing: 'sharing',
} as const;

/** What the home screen is told beside its cards. Each part is absent when there is nothing to say. */
export interface HomeState {
  /** Her light, as the family would see it. Absent when nobody can see one. */
  readonly light?: 'on' | 'out';
  /**
   * With `light: 'out'`: the moment it stops being out — the end of the day
   * where the house is (endOfLocalDay). A television left on overnight goes
   * by this and not by its own calendar, so it never goes on saying "Light
   * out" into a day the family can see lit.
   */
  readonly lightOutUntil?: number;
  /**
   * The latest person to ask after her today, by the first name she knows
   * them by — and the sentence that says so, written where the household's
   * time zone is known (lookedInWords), so a television whose own clock is
   * set elsewhere still says "this morning" at the right time.
   */
  readonly lookedIn?: {
    readonly name: string;
    readonly at: number;
    readonly line: string;
    /** When the look stops being today's: the end of that day where the house is. The television shows the line until then. */
    readonly until?: number;
  };
  /**
   * The language her television speaks (language.ts), when it is not
   * English. It rides here because this is the one thing every television
   * of the home is told whole, at every connection.
   */
  readonly language?: OtherLanguage;
  /**
   * How many things are on her mantelpiece (mantel.ts), when there are
   * any — so the home screen knows to offer it. A count and nothing else:
   * what they are is asked for by the television, never told on the way.
   */
  readonly mantel?: number;
  /**
   * Her day (today.ts): the date where the house is, her name for the
   * greeting, and who is coming today and tomorrow. Absent from a server
   * that does not say it; the home screen is then as it was.
   */
  readonly today?: HerDay;
}

const dayIn = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Whether two moments fall on the same calendar day where the house is. */
export function sameLocalDay(a: number, b: number, timeZone: string): boolean {
  return dayIn(a, timeZone) === dayIn(b, timeZone);
}

/**
 * The first moment of the next day where the house is: when "today" is
 * over. Found by looking, not by adding twenty-four hours — the days the
 * clocks change are twenty-three and twenty-five hours long.
 */
export function endOfLocalDay(at: number, timeZone: string): number {
  const today = dayIn(at, timeZone);
  // Still today at `still`; already another day at `past` (no day is longer than twenty-five hours).
  let still = at;
  let past = at + 26 * 3_600_000;
  while (past - still > 1) {
    const middle = still + Math.floor((past - still) / 2);
    if (dayIn(middle, timeZone) === today) still = middle;
    else past = middle;
  }
  return past;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * A home screen's state from something that is not this code — the bus
 * between the edge and the agent plane. What is well formed is kept, part
 * by part; anything else, and anything unknown, is dropped. Undefined when
 * it is not a state at all.
 */
export function readHomeState(value: unknown): HomeState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { light, lightOutUntil, lookedIn, language, mantel, today } = value as Record<string, unknown>;
  const day = readHerDay(today);
  const look = typeof lookedIn === 'object' && lookedIn !== null ? (lookedIn as Record<string, unknown>) : undefined;
  const wellFormedLook = look !== undefined && typeof look.name === 'string' && isTime(look.at) && typeof look.line === 'string';
  return {
    ...(light === 'on' || light === 'out' ? { light } : {}),
    ...(light === 'out' && isTime(lightOutUntil) ? { lightOutUntil } : {}),
    ...(wellFormedLook
      ? { lookedIn: { name: look.name as string, at: look.at as number, line: look.line as string, ...(isTime(look.until) ? { until: look.until } : {}) } }
      : {}),
    ...(isHouseholdLanguage(language) && language !== DEFAULT_LANGUAGE ? { language } : {}),
    ...(typeof mantel === 'number' && Number.isInteger(mantel) && mantel >= 1 && mantel <= MAX_MANTEL ? { mantel } : {}),
    ...(day ? { today: day } : {}),
  };
}

/**
 * Whether the light is lit now: a television in the home has been in use
 * today, and she has not put the light out today.
 *
 * One answer, on purpose. Callers must not tell "out" from "not yet lit".
 */
export function isLit(input: {
  /** When each of the home's televisions last said someone was at it. */
  readonly activeAts: readonly number[];
  readonly outAt?: number | undefined;
  readonly now: number;
  readonly timeZone: string;
}): boolean {
  const { activeAts, outAt, now, timeZone } = input;
  if (outAt !== undefined && sameLocalDay(outAt, now, timeZone)) return false;
  return activeAts.some((at) => sameLocalDay(at, now, timeZone));
}

/** The latest look of today, or nobody. */
export function lookedInToday(
  looks: readonly { readonly name: string; readonly at: number }[],
  now: number,
  timeZone: string,
): { readonly name: string; readonly at: number } | undefined {
  return looks
    .filter((look) => sameLocalDay(look.at, now, timeZone))
    .sort((a, b) => b.at - a.at)[0];
}

/** "this morning", "this afternoon" or "this evening", where the house is. */
function partOfDay(at: number, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
  return hour < 12 ? 'this morning' : hour < 18 ? 'this afternoon' : 'this evening';
}

/** "Sarah looked in this morning." — the one sentence, on her home screen and on the Light card. */
export function lookedInWords(name: string, at: number, timeZone: string): string {
  return `${name} looked in ${partOfDay(at, timeZone)}.`;
}
