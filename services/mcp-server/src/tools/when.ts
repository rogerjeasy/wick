/**
 * Days and times as a household means them.
 *
 * "Saturday at three" is three o'clock where the house is, not in UTC. The
 * door matches a ring against an absolute moment (services/agent/src/
 * agents/door/roster.ts), so a time somebody says has to be turned into
 * one here, once, in the household's own zone.
 */
const DAY_MS = 86_400_000;

/** The wall-clock time `atMs` shows in `timeZone`, read back as if it were UTC. */
export function wallClockAsUtc(atMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(atMs));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}

/**
 * A wall-clock time, written as if it were UTC (Monday 09:00 as
 * `Date.UTC(…, 9, 0)`), as the moment it is in `timeZone`: nine o'clock
 * where the house is. Exact except inside the hour a clock change skips or
 * repeats.
 */
export function wallClockToMoment(asUtc: number, timeZone: string): number {
  return asUtc - (wallClockAsUtc(asUtc, timeZone) - asUtc);
}

/** "2026-10-17", "15:00" in the household's zone -> the moment, or undefined if either is not a real date or time. */
export function localToUtc(date: string, time: string, timeZone: string): number | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return undefined;
  const [year, month, day, hour, minute] = [d[1], d[2], d[3], t[1], t[2]].map(Number) as [number, number, number, number, number];
  if (hour > 23 || minute > 59) return undefined;

  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  // The zone's offset at that moment, applied once: exact except inside the
  // hour a clock change skips or repeats, which no visit is planned by.
  return asUtc - (wallClockAsUtc(asUtc, timeZone) - asUtc);
}

/** The UTC day a "YYYY-MM-DD" names, as its first millisecond — the day the timeline's rows are filed by. */
export function utcDayStart(date: string): number | undefined {
  const at = localToUtc(date, '00:00', 'UTC');
  return at === undefined ? undefined : at - (at % DAY_MS);
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface ResolvedDay {
  /** The day's first millisecond where the house is (its own midnight, as a moment). */
  readonly start: number;
  /** YYYY-MM-DD. */
  readonly date: string;
  /** "Tuesday 6 October 2026" — so whoever reads the answer can see which day it is for. */
  readonly inWords: string;
}

/**
 * The day a question means. An exact `date` wins; otherwise `day` is
 * "today", "yesterday" or a weekday, which is the most recent such day,
 * today included; with neither, today. Undefined for anything else.
 *
 * Worked out here because a model asked to turn "last Tuesday" into a date
 * got Thursday, and answered — wrongly, and with confidence — for that.
 *
 * Every day is the house's own (`timeZone`): "today", asked at seven in the
 * evening in Seattle, is that day in Seattle, not the next one in UTC.
 */
export function resolveDay(
  input: { readonly date?: string | undefined; readonly day?: string | undefined },
  now: Date,
  timeZone = 'UTC',
): ResolvedDay | undefined {
  const today = localDate(now.getTime(), timeZone);
  let date: string | undefined;

  if (input.date !== undefined) date = utcDayStart(input.date) === undefined ? undefined : input.date;
  else if (input.day === undefined || input.day.trim().toLowerCase() === 'today') date = today;
  else if (input.day.trim().toLowerCase() === 'yesterday') date = addDays(today, -1);
  else {
    const weekday = WEEKDAYS.indexOf(input.day.trim().toLowerCase());
    if (weekday !== -1) date = addDays(today, -((weekdayOf(today) - weekday + 7) % 7));
  }
  if (date === undefined) return undefined;
  // The day as it is where the house is: from its own midnight to the next.
  const start = localToUtc(date, '00:00', timeZone);
  if (start === undefined) return undefined;

  const inWords = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(utcDayStart(date)!))
    .replace(',', '');
  return { start, date, inWords };
}

/** "2026-10-18": the calendar date `atMs` falls on where the house is. */
export function localDate(atMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(atMs));
}

/** A calendar date `days` on (or back, when negative) from `date`. */
function addDays(date: string, days: number): string {
  return new Date(utcDayStart(date)! + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 for a Sunday: the weekday of a calendar date. */
const weekdayOf = (date: string): number => new Date(utcDayStart(date)!).getUTCDay();

/**
 * The day `atMs` falls in where the house is: its first millisecond and the
 * first of the next. Not always 24 hours apart — a clock change makes one
 * day of the year 23 hours long and another 25.
 */
export function localDayBounds(atMs: number, timeZone: string): { readonly start: number; readonly end: number } {
  const date = localDate(atMs, timeZone);
  return { start: localToUtc(date, '00:00', timeZone)!, end: localToUtc(addDays(date, 1), '00:00', timeZone)! };
}

/** What a tool's `day` argument accepts, for its schema. */
export const DAY_ARGUMENT = 'One of "today", "yesterday", or a weekday name ("tuesday"): the most recent such day, today included.';

/** As far back as a day can be asked about: the weeks a usual week is drawn from (rhythm/baseline.ts). */
export const DAYS_BACK = 42;

export const DAY_NOT_A_DATE_TEXT = 'I need the day as a date for that.';
export const DAY_NOT_YET_TEXT = 'That day has not come yet.';
export const DAY_TOO_OLD_TEXT = 'That is further back than I keep day by day. I can tell you about the last six weeks.';

/**
 * The day a question means, if it is one Wick answers for: a real day, not
 * in the future, and within the last six weeks. Otherwise the sentence to
 * say instead. One rule for every tool that takes a day — a bound on one
 * and not on its sibling is a bound on neither.
 */
export function resolveRecentDay(
  asked: { readonly date?: string | undefined; readonly day?: string | undefined },
  now: Date,
  timeZone = 'UTC',
): { readonly ok: true; readonly day: ResolvedDay } | { readonly ok: false; readonly say: string } {
  const today = localDate(now.getTime(), timeZone);
  const day = resolveDay(asked, now, timeZone);
  if (!day) return { ok: false, say: DAY_NOT_A_DATE_TEXT };
  if (day.date > today) return { ok: false, say: DAY_NOT_YET_TEXT };
  if (day.date < addDays(today, -DAYS_BACK)) return { ok: false, say: DAY_TOO_OLD_TEXT };
  return { ok: true, day };
}
