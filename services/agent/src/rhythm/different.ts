/**
 * D1 — Something's Different: the few things about today that are unlike
 * this household's own usual, said plainly (docs/WICK.md §5.3).
 *
 * Never an alert. A difference is a sentence the family can read when they
 * next look, in the same calm register as the week — and most days there
 * is none, which is also an answer.
 *
 * Three things are looked for, each against the household's own last six
 * weeks and nothing else:
 *
 *   - a regular visitor who did not come on one of their days;
 *   - somebody at the door in the night, in a house where nobody comes at
 *     night;
 *   - a day at the door unlike the same weekday usually is by this hour.
 *
 * The rules that keep it honest are the Rhythm baseline's (baseline.ts,
 * §8.2: "a false 'something's different' is worse than the feature's
 * absence"), applied by the day:
 *
 *   - Nothing is called different from fewer than three observed weeks.
 *   - A visitor's day is only theirs once they have come on it three
 *     times. A schedule somebody typed in is an expectation; three visits
 *     are a habit.
 *   - A day is compared with the same stretch of the same weekday — nine
 *     in the morning against nine in the morning — and never for differing
 *     by a single caller.
 *
 * Pure: no AWS, no model. Every sentence is written here. A model never
 * counts (§5.4), and it never decides what is unusual either.
 */
import { fromLocalWallClock, localWallClock, type FactClass, type RosterEntry, type TimelineEntry } from '@wick/contracts';
import { BASELINE_WEEKS, MIN_BASELINE_WEEKS, deltaFor } from './baseline.js';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const HOUR_MS = 3_600_000;

/** How long after a visitor's window closes before "has not come" is said. */
export const VISIT_GRACE_MS = 2 * HOUR_MS;
/** The night, in the household's own clock: from eleven until five. */
export const NIGHT_FROM_HOUR = 23;
export const NIGHT_UNTIL_HOUR = 5;

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/**
 * The first four are found by the detector below. `visit_disputed` is not: it
 * is the resident saying that what the door noted of a visit is not right
 * (agents/visit/answer.ts), filed as a question of the same kind so that
 * whether the family hears of it is hers to decide in the same way.
 */
export type DifferenceKind = 'missed_visit' | 'door_at_night' | 'door_quiet' | 'door_busy' | 'visit_disputed';

export interface Difference {
  readonly kind: DifferenceKind;
  /** What it is about — which is what decides whether the family may be told (fact.ts). */
  readonly factClass: Extract<FactClass, 'PRESENCE' | 'DOOR_EVENT'>;
  /** Plain words, written here. */
  readonly sentence: string;
  /**
   * The same thing, said so that it is still true when read on another day:
   * the day by name, never "today". It is what the resident is shown when
   * asked "Shall I tell Sarah?" and, word for word, what the family is then
   * told (tell.ts) — which may be days after it was noticed.
   */
  readonly lasting: string;
  /** The moment it is about: the visit that did not happen, the call in the night, the start of today. */
  readonly at: number;
  readonly personId?: string;
}

export interface DifferentInput {
  /** The household's timeline for the six weeks before `now`, and today. More is ignored. */
  readonly entries: readonly TimelineEntry[];
  readonly roster: readonly RosterEntry[];
  readonly now: number;
  /** The household's first recorded event, ever. Absent when there is none. */
  readonly observedSince: number | undefined;
  /** The household's IANA time zone: "the night" is theirs. */
  readonly timeZone: string;
}

export interface DifferentAnswer {
  /** Whole weeks Wick has been watching, at most six. */
  readonly weeksObserved: number;
  /** False below three weeks: there is no usual yet, so nothing can be unlike it. */
  readonly enoughHistory: boolean;
  /** Most worth knowing first. Empty on a usual day. */
  readonly differences: readonly Difference[];
}

/** 0 for a Sunday: the weekday of a midnight on the house's wall clock (localWallClock). */
const weekday = (dayWall: number): number => new Date(dayWall).getUTCDay();

function partOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return 'mornings';
  if (hour >= 12 && hour < 17) return 'afternoons';
  if (hour >= 17 && hour < 22) return 'evenings';
  return 'nights';
}

interface WeeklyPattern {
  readonly days: readonly number[];
  readonly minuteOfDay: number;
  readonly windowMin: number;
}

/** "TUE,FRI 09:00±30m". Undefined for a pattern it cannot read. */
export function parsePattern(pattern: string | undefined): WeeklyPattern | undefined {
  const m = /^([A-Z,]+)\s+(\d{2}):(\d{2})(?:±(\d+)m)?/.exec(pattern?.trim() ?? '');
  if (!m) return undefined;
  const days = m[1]!.split(',').map((code) => DAY_CODES.indexOf(code as (typeof DAY_CODES)[number]));
  if (days.length === 0 || days.includes(-1)) return undefined;
  return { days, minuteOfDay: Number(m[2]) * 60 + Number(m[3]), windowMin: Number(m[4] ?? 0) };
}

function missedVisits(input: DifferentInput): Difference[] {
  const { entries, roster, now, observedSince, timeZone } = input;
  // Her days are the house's own: midnight to midnight where she lives, on its wall clock
  // (packages/contracts clock.ts). Read in UTC, a carer due at nine in Seattle was "missed" at half past four.
  const todayWall = localWallClock(now, timeZone) - (localWallClock(now, timeZone) % DAY_MS);
  const moment = (wall: number): number => fromLocalWallClock(wall, timeZone);
  const out: Difference[] = [];

  for (const person of roster) {
    if (person.expectedOnce) continue;
    const pattern = parsePattern(person.expectedPattern);
    if (!pattern) continue;

    // The latest of their days whose window, and the grace after it, is over.
    let daysAgo = -1;
    for (let d = 0; d < 7; d += 1) {
      const dayWall = todayWall - d * DAY_MS;
      if (!pattern.days.includes(weekday(dayWall))) continue;
      const over = moment(dayWall + (pattern.minuteOfDay + pattern.windowMin) * 60_000) + VISIT_GRACE_MS;
      if (over <= now) {
        daysAgo = d;
        break;
      }
    }
    if (daysAgo < 0) continue;
    const dayWall = todayWall - daysAgo * DAY_MS;
    const day = moment(dayWall);

    const visits = entries.filter((e) => e.kind === 'visit' && e.personId === person.personId).map((e) => e.at);
    // Came that day, or since: late is not missing.
    if (visits.some((at) => at >= day && at <= now)) continue;

    // A habit, not a schedule: they came on this weekday at least three times before.
    let cameBefore = 0;
    for (let k = 1; k <= BASELINE_WEEKS; k += 1) {
      const priorWall = dayWall - k * WEEK_MS;
      const prior = moment(priorWall);
      if (observedSince === undefined || observedSince > prior) break;
      const priorEnd = moment(priorWall + DAY_MS);
      if (visits.some((at) => at >= prior && at < priorEnd)) cameBefore += 1;
    }
    if (cameBefore < MIN_BASELINE_WEEKS) continue;

    const dayName = DAY_NAMES[weekday(dayWall)]!;
    const usual = `${person.name} usually comes on ${dayName} ${partOfDay(Math.floor(pattern.minuteOfDay / 60))}.`;
    const absent = daysAgo === 0 ? 'There has been no visit today.' : daysAgo === 1 ? 'There was no visit yesterday.' : `There was no visit on ${dayName}.`;
    out.push({
      kind: 'missed_visit',
      factClass: 'PRESENCE',
      sentence: `${usual} ${absent}`,
      lasting: `${usual} There was no visit on ${dayName}.`,
      at: moment(dayWall + pattern.minuteOfDay * 60_000),
      personId: person.personId,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

function localHour(at: number, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

const atNight = (at: number, timeZone: string): boolean => {
  const hour = localHour(at, timeZone);
  return hour >= NIGHT_FROM_HOUR || hour < NIGHT_UNTIL_HOUR;
};

/** "2:10 am", on the household's own clock. */
const clockTime = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at);

const localDayName = (at: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long' }).format(at);

function doorAtNight(input: DifferentInput, weeksObserved: number): Difference[] {
  const { entries, now, observedSince, timeZone } = input;
  if (observedSince === undefined) return [];
  const since = now - DAY_MS;
  const nightCalls = entries.filter((e) => e.kind === 'door' && e.at <= now && atNight(e.at, timeZone));
  const recent = nightCalls.filter((e) => e.at > since).sort((a, b) => b.at - a.at)[0];
  if (!recent) return [];
  // A house where people do come at night has nothing different about tonight.
  const from = Math.max(observedSince, now - BASELINE_WEEKS * WEEK_MS);
  if (nightCalls.some((e) => e.at >= from && e.at <= since)) return [];

  const time = clockTime(recent.at, timeZone);
  const before = `Nobody had come at night in the ${weeksObserved} weeks before.`;
  return [{
    kind: 'door_at_night',
    factClass: 'DOOR_EVENT',
    sentence: `Someone came to the door in the night, at ${time}. ${before}`,
    lasting: `Someone came to the door in the night, at ${time} on ${localDayName(recent.at, timeZone)}. ${before}`,
    at: recent.at,
  }];
}

function doorToday(input: DifferentInput): Difference[] {
  const { entries, now, observedSince, timeZone } = input;
  // Today is the house's own day, from its midnight (packages/contracts clock.ts).
  const todayWall = localWallClock(now, timeZone) - (localWallClock(now, timeZone) % DAY_MS);
  const today = fromLocalWallClock(todayWall, timeZone);
  const elapsed = now - today;
  const doorTimes = entries.filter((e) => e.kind === 'door').map((e) => e.at);
  const countIn = (from: number): number => doorTimes.filter((at) => at >= from && at < from + elapsed).length;

  const priorWeeks: number[] = [];
  for (let k = 1; k <= BASELINE_WEEKS; k += 1) {
    const prior = fromLocalWallClock(todayWall - k * WEEK_MS, timeZone);
    if (observedSince === undefined || observedSince > prior) break;
    priorWeeks.push(countIn(prior));
  }
  const callers = doorTimes.filter((at) => at >= today && at <= now).length;
  const delta = deltaFor({ metric: 'door', label: 'the front door', thisWeek: callers, priorWeeks });
  if (delta.verdict !== 'more' && delta.verdict !== 'fewer') return [];

  const dayName = DAY_NAMES[weekday(todayWall)]!;
  const about = `on a ${dayName} there are usually about ${Math.round(delta.baseline)}.`;
  const usual = `By this time ${about}`;
  // Said later, "by this time" means nothing: the hour it was noticed is part of the fact.
  const usualThen = `By that time ${about}`;
  const byThen = `by ${clockTime(now, timeZone)}`;
  if (delta.verdict === 'fewer') {
    const said = callers === 0 ? 'Nobody has come to the door today.' : `Fewer people than usual have come to the door today: ${callers}.`;
    const saidThen = callers === 0
      ? `Nobody had come to the door ${byThen} on ${dayName}.`
      : `Fewer people than usual had come to the door ${byThen} on ${dayName}: ${callers}.`;
    return [{ kind: 'door_quiet', factClass: 'DOOR_EVENT', sentence: `${said} ${usual}`, lasting: `${saidThen} ${usualThen}`, at: today }];
  }
  return [{
    kind: 'door_busy',
    factClass: 'DOOR_EVENT',
    sentence: `The door has been busier than usual today: ${callers} callers. ${usual}`,
    lasting: `The door was busier than usual on ${dayName}: ${callers} callers ${byThen}. ${usualThen}`,
    at: today,
  }];
}

/** What is unlike this household's usual, right now. Most worth knowing first. */
export function whatsDifferent(input: DifferentInput): DifferentAnswer {
  const { now, observedSince } = input;
  const weeksObserved = observedSince === undefined ? 0 : Math.min(BASELINE_WEEKS, Math.max(0, Math.floor((now - observedSince) / WEEK_MS)));
  const enoughHistory = weeksObserved >= MIN_BASELINE_WEEKS;
  if (!enoughHistory) return { weeksObserved, enoughHistory, differences: [] };

  return {
    weeksObserved,
    enoughHistory,
    differences: [...missedVisits(input), ...doorAtNight(input, weeksObserved), ...doorToday(input)],
  };
}
