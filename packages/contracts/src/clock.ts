/**
 * The day and the time where the house is.
 *
 * A regular visitor's "TUE,FRI 09:00±30m" is said on the household's own
 * clock, and stays on it: nine o'clock is nine o'clock in summer and in
 * winter. Everything that compares a moment with such a pattern reads the
 * moment here, never in UTC (issue #84).
 */
export const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type DayCode = (typeof DAY_CODES)[number];

function parts(at: number, timeZone: string): { readonly weekday: string; readonly hour: number; readonly minute: number } {
  const found = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => found.find((p) => p.type === type)?.value ?? '';
  return { weekday: part('weekday').toUpperCase(), hour: Number(part('hour')), minute: Number(part('minute')) };
}

/** "TUE" for a moment that is a Tuesday where the house is. */
export function localDayCode(at: number, timeZone: string): DayCode {
  const day = parts(at, timeZone).weekday as DayCode;
  return DAY_CODES.includes(day) ? day : DAY_CODES[new Date(at).getUTCDay()]!;
}

/** Minutes since midnight where the house is: 09:59 is 599. */
export function localMinuteOfDay(at: number, timeZone: string): number {
  const { hour, minute } = parts(at, timeZone);
  return (hour % 24) * 60 + minute;
}

/**
 * Where the house is: the household's own IANA time zone, kept as
 * `timeZone` on its `HH#<household>` / `META` row. It is given when the
 * home is set up — from the browser of the person setting it up, which they
 * can correct on the same page — and every day, "this morning", visit time
 * and week of that home is read in it.
 *
 * A home set up before homes had one has none, and is read in
 * DEFAULT_HOUSEHOLD_TIME_ZONE: Wick's first homes were all in England.
 */
export const HOUSEHOLD_TIME_ZONE_ATTR = 'timeZone';
export const DEFAULT_HOUSEHOLD_TIME_ZONE = 'Europe/London';

/** The longest IANA name is about 30 characters; anything far past that is not one. */
const MAX_TIME_ZONE_LENGTH = 64;

/**
 * Whether `value` names a time zone this runtime knows ("America/Los_Angeles",
 * "Europe/London", "UTC"). Asked of Intl itself, so a name it cannot read
 * is never kept and later thrown on.
 */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A household's zone from its META row, or the default for a home that was given none. */
export function timeZoneOfMeta(item: { readonly [HOUSEHOLD_TIME_ZONE_ATTR]?: { readonly S?: string } } | undefined): string {
  const zone = item?.[HOUSEHOLD_TIME_ZONE_ATTR]?.S;
  return isTimeZone(zone) ? zone : DEFAULT_HOUSEHOLD_TIME_ZONE;
}

/** The wall-clock time `at` shows where the house is, written as if it were UTC: nine o'clock there is `Date.UTC(…, 9, 0)`. */
export function localWallClock(at: number, timeZone: string): number {
  const found = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(found.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second')) + (at % 1000 + 1000) % 1000;
}

/**
 * The moment a wall-clock time (written as if it were UTC) is where the
 * house is: the other way from localWallClock. Exact except inside the hour
 * a clock change skips or repeats, where it lands on one side of it.
 */
export function fromLocalWallClock(wallClock: number, timeZone: string): number {
  const guess = wallClock - (localWallClock(wallClock, timeZone) - wallClock);
  return wallClock - (localWallClock(guess, timeZone) - guess);
}

/** The first moment of the day `at` falls on where the house is: its own midnight. */
export function localDayStart(at: number, timeZone: string): number {
  const wall = localWallClock(at, timeZone);
  return fromLocalWallClock(wall - (wall % 86_400_000), timeZone);
}

/**
 * "14:00" in a note is read on her television by somebody who says "two in
 * the afternoon". A note's words are the family member's own, and the
 * assistant tends to write a time as 24-hour; the television says the rest of
 * its times on a 12-hour clock ("Maria was here from 9:02 am", visit.ts).
 * So a time that can only be 24-hour is said that way too: "14:00" becomes
 * "2 pm", "19:30" "7:30 pm", "08:15" "8:15 am", "00:00" "midnight". A time
 * that could be either ("7:30", "12:15") is left exactly as it was written:
 * turning "7:30" into "7:30 am" could make an evening visit a morning one.
 * A time already marked am or pm is never touched, and nothing else in the
 * note changes.
 *
 * Mirrored in apps/sim-alexa/surface.js (`saidOnHerClock`), so the family
 * app shows the note as her television will; a test holds the two together.
 */
export function saidOnHerClock(text: string): string {
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:[ap]\.?m\b\.?))/gi, (found, h: string, m: string) => {
    const hour = Number(h);
    const minutes = m === '00' ? '' : `:${m}`;
    if (hour >= 13) return `${hour - 12}${minutes} pm`;
    if (hour === 0) return minutes ? `12${minutes} am` : 'midnight';
    if (h.length === 2 && h.startsWith('0')) return `${hour}${minutes} am`;
    return found;
  });
}
