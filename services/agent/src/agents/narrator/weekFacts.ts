/**
 * §5.4's rule, "THE MODEL NEVER COUNTS", made checkable rather than hoped.
 *
 * summariseWeek does all the counting, in the household's own time zone (a
 * 23:30 UTC visit is Thursday night in London, not Wednesday). factLines
 * turns those counts into the only facts the model is shown. checkNarrative
 * then rejects any prose that uses a number the facts never supplied, or
 * that is too long for the television card (MAX_NARRATIVE_CHARS). And
 * fallbackNarrative writes the week from the facts alone, for when the
 * model's prose fails the check twice.
 *
 * The first real run, on 2026-10-01, is why this exists. Handed raw
 * timestamps, Sonnet wrote "six separate arrivals" and "just before ten
 * o'clock" in UTC. That was 600 characters, and it pushed the card's one
 * button off the screen.
 */
import { MAX_NARRATIVE_CHARS, type TimelineEntry } from '@wick/contracts';
import type { WeekRange } from './isoWeek.js';

export type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export interface DoorTime {
  readonly day: string;
  readonly part: PartOfDay;
  readonly count: number;
}

export interface NamedVisits {
  readonly name: string;
  readonly count: number;
}

export interface WeekFacts {
  readonly doorVisits: number;
  /** Door visits by local day and part of day, in chronological order. */
  readonly doorTimes: readonly DoorTime[];
  readonly visits: readonly NamedVisits[];
  /** False when the narrative is written before the week has ended. */
  readonly weekComplete: boolean;
  /** The last local day the facts cover. */
  readonly throughDay: string;
}

export interface SummariseOptions {
  readonly timeZone: string;
  readonly range: WeekRange;
  readonly now: number;
}

export type NarrativeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'empty' | 'too_long' | 'unsupported_number'; readonly detail?: string };

function localDayAndHour(at: number, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(at));
  return {
    day: parts.find((p) => p.type === 'weekday')!.value,
    hour: Number(parts.find((p) => p.type === 'hour')!.value),
  };
}

function partOfDay(hour: number): PartOfDay {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

const VISITED = /^(.+) visited\.$/;

export function summariseWeek(entries: readonly TimelineEntry[], options: SummariseOptions): WeekFacts {
  const { timeZone, range, now } = options;
  const sorted = [...entries].sort((a, b) => a.at - b.at);

  const doorTimes: { day: string; part: PartOfDay; count: number }[] = [];
  const visits: { name: string; count: number }[] = [];
  let doorVisits = 0;

  for (const entry of sorted) {
    if (entry.kind === 'door') {
      doorVisits += 1;
      const { day, hour } = localDayAndHour(entry.at, timeZone);
      const part = partOfDay(hour);
      const last = doorTimes[doorTimes.length - 1];
      if (last && last.day === day && last.part === part) last.count += 1;
      else doorTimes.push({ day, part, count: 1 });
    } else if (entry.kind === 'visit') {
      const name = VISITED.exec(entry.summary)?.[1];
      if (!name || name === 'Someone') continue;
      const known = visits.find((v) => v.name === name);
      if (known) known.count += 1;
      else visits.push({ name, count: 1 });
    }
  }

  const weekComplete = now >= range.endMs;
  const lastCovered = weekComplete ? range.endMs - 1 : Math.max(range.startMs, now);
  return { doorVisits, doorTimes, visits, weekComplete, throughDay: localDayAndHour(lastCovered, timeZone).day };
}

const times = (n: number): string => `${n} ${n === 1 ? 'time' : 'times'}`;

/** The only facts the model is shown. Every number it may use is here. */
export function factLines(facts: WeekFacts): string[] {
  const lines = [
    facts.weekComplete
      ? 'This is the whole week: Monday to Sunday.'
      : `This is the week so far: Monday to ${facts.throughDay}. The week is not over.`,
  ];
  lines.push(facts.doorVisits === 0 ? 'Nobody came to the front door.' : `Someone came to the front door ${times(facts.doorVisits)}.`);
  for (const t of facts.doorTimes) lines.push(`${t.day} ${t.part}: ${times(t.count)} at the front door.`);
  for (const v of facts.visits) lines.push(`${v.name} visited ${times(v.count)}.`);
  return lines;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, once: 1, twice: 2, thrice: 3, dozen: 12, half: 0.5,
};
const NUMBER_PATTERN = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi');

function allowedNumbers(facts: WeekFacts): ReadonlySet<number> {
  return new Set([facts.doorVisits, ...facts.doorTimes.map((t) => t.count), ...facts.visits.map((v) => v.count)]);
}

export function checkNarrative(text: string, facts: WeekFacts): NarrativeCheck {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_NARRATIVE_CHARS) return { ok: false, reason: 'too_long', detail: String(trimmed.length) };

  const allowed = allowedNumbers(facts);
  // "no one" is nobody, not a count of one.
  const scannable = trimmed.replace(/\bno one\b/gi, 'nobody');
  for (const match of scannable.matchAll(NUMBER_PATTERN)) {
    const token = match[1]!;
    const value = NUMBER_WORDS[token.toLowerCase()] ?? Number(token);
    if (!allowed.has(value)) return { ok: false, reason: 'unsupported_number', detail: token };
  }
  return { ok: true };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "once", "twice", "three times" … "13 times". */
function spokenTimes(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${WORDS[n] ?? String(n)} times`;
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The week from the facts alone — no model, nothing invented. Always passes checkNarrative. */
export function fallbackNarrative(facts: WeekFacts): string {
  const fits = (sentences: readonly string[]) => sentences.join(' ').length <= MAX_NARRATIVE_CHARS;

  let door: string;
  if (facts.doorVisits === 0) {
    door = facts.weekComplete ? 'A quiet week. Nobody came to the front door.' : 'A quiet week so far. Nobody has come to the front door since Monday.';
  } else {
    door = `Someone came to the front door ${spokenTimes(facts.doorVisits)} ${facts.weekComplete ? 'this week' : 'so far this week'}.`;
  }

  // Who visited matters more than when the door was busy, so names claim
  // their room first and the time-of-day breakdown gets whatever is left.
  const named: string[] = [];
  for (const v of facts.visits) {
    const sentence = `${v.name} visited ${spokenTimes(v.count)}.`;
    if (fits([door, ...named, sentence])) named.push(sentence);
  }

  if (facts.doorTimes.length > 0) {
    const when = facts.doorTimes.map((t) => `${spokenTimes(t.count)} on ${t.day} ${t.part}`);
    const detailed = `${door.slice(0, -1)}: ${list(when)}.`;
    if (fits([detailed, ...named])) door = detailed;
  }

  return [door, ...named].join(' ');
}
