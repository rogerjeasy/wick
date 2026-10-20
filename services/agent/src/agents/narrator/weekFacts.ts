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
import { MAX_NARRATIVE_CHARS, fromLocalWallClock, unheardDayStarts, type RhythmDelta, type TimelineEntry } from '@wick/contracts';
import type { WeekRange } from './isoWeek.js';
import { checkComparisons, comparisonNumbers, comparisonSentences, visibleDeltas } from './comparisons.js';
import { spokenTimes, times } from './words.js';

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
  /**
   * How often somebody came to the door when each regular visitor was
   * expected (`presence`). When, never who: a courier in the carer's hour
   * counts here too (packages/contracts visit.ts).
   */
  readonly whenExpected: readonly NamedVisits[];
  /** The visits the resident confirmed on her television, by visitor: the only count of who came. */
  readonly confirmed: readonly NamedVisits[];
  /**
   * The days of the week, by name, the doorbell was not heard at all
   * (packages/contracts heard.ts). Nothing is said of who came on them, and
   * the week is not called quiet.
   */
  readonly unheardDays: readonly string[];
  /**
   * False when the narrative is written with the week still under way —
   * true from Sunday evening on (TOLD_AS_THE_WEEK_MS), not only after
   * midnight.
   */
  readonly weekComplete: boolean;
  /** The last local day the facts cover. */
  readonly throughDay: string;
}

export interface SummariseOptions {
  readonly timeZone: string;
  readonly range: WeekRange;
  readonly now: number;
  /** The hours the doorbell was heard, as hour starts; with `trackedSince`, the first of them ever. */
  readonly heard?: readonly number[];
  readonly trackedSince?: number;
  /** A week already counted says which days were unheard (WeekNarrative.unheardDays): that list stands. */
  readonly unheardDays?: readonly string[];
}

/** The local midnights of the week's seven days, Monday first. */
function localDayStarts(range: WeekRange, timeZone: string): number[] {
  return Array.from({ length: 7 }, (_, d) => fromLocalWallClock(range.startMs + d * 86_400_000, timeZone));
}

/** Which of the week's days, by name, the doorbell was not heard on. */
export function unheardDaysOf(range: WeekRange, timeZone: string, now: number, heard: readonly number[], trackedSince: number | undefined): string[] {
  return unheardDayStarts(heard, localDayStarts(range, timeZone), now, trackedSince).map((start) => localDayAndHour(start, timeZone).day);
}

export type NarrativeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'empty' | 'too_long' | 'unsupported_number' | 'unsupported_comparison' | 'unconfirmed_visit' | 'unheard_absence'; readonly detail?: string };

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

/**
 * From how long before the week ends its telling is the week's, not "the
 * week so far". The Narrator runs on Sunday evening (infra/narrator.tf, 20:00
 * UTC) and that story is what the resident reads then, and what the family
 * reads on any day of the week after — when "so far this week" is no longer
 * true of anything. Six hours covers that run in every time zone's Sunday
 * evening without reaching back into its afternoon.
 */
export const TOLD_AS_THE_WEEK_MS = 6 * 3_600_000;

export function summariseWeek(entries: readonly TimelineEntry[], options: SummariseOptions): WeekFacts {
  const { timeZone, range, now } = options;
  const sorted = [...entries].sort((a, b) => a.at - b.at);

  const doorTimes: { day: string; part: PartOfDay; count: number }[] = [];
  const whenExpected: { name: string; count: number }[] = [];
  const confirmed: { name: string; count: number }[] = [];
  let doorVisits = 0;
  const add = (to: { name: string; count: number }[], name: string) => {
    const known = to.find((v) => v.name === name);
    if (known) known.count += 1;
    else to.push({ name, count: 1 });
  };

  for (const entry of sorted) {
    if (entry.kind === 'door') {
      doorVisits += 1;
      const { day, hour } = localDayAndHour(entry.at, timeZone);
      const part = partOfDay(hour);
      const last = doorTimes[doorTimes.length - 1];
      if (last && last.day === day && last.part === part) last.count += 1;
      else doorTimes.push({ day, part, count: 1 });
    } else if (entry.kind === 'presence' && entry.name) {
      add(whenExpected, entry.name);
    } else if (entry.kind === 'visit' && entry.name) {
      add(confirmed, entry.name);
    }
  }

  const weekComplete = now >= range.endMs - TOLD_AS_THE_WEEK_MS;
  // A whole week ends on its Sunday by definition; the range's last instant
  // is already Monday morning east of Greenwich.
  const throughDay = weekComplete ? 'Sunday' : localDayAndHour(Math.max(range.startMs, now), timeZone).day;
  const unheardDays = options.unheardDays ?? (options.heard ? unheardDaysOf(range, timeZone, now, options.heard, options.trackedSince) : []);
  return { doorVisits, doorTimes, whenExpected, confirmed, unheardDays, weekComplete, throughDay };
}

/** The only facts the model is shown. Every number it may use is here. */
export function factLines(facts: WeekFacts): string[] {
  const lines = [
    facts.weekComplete
      ? 'This is the whole week: Monday to Sunday.'
      : `This is the week so far: Monday to ${facts.throughDay}. The week is not over.`,
  ];
  lines.push(facts.doorVisits === 0 ? 'Nobody came to the front door.' : `Someone came to the front door ${times(facts.doorVisits)}.`);
  for (const t of facts.doorTimes) lines.push(`${t.day} ${t.part}: ${times(t.count)} at the front door.`);
  for (const v of facts.whenExpected) lines.push(`Someone came to the door ${times(v.count)} when ${v.name} was expected. That alone does not say who it was.`);
  for (const v of facts.confirmed) lines.push(`The resident confirmed on the television that ${v.name} came ${times(v.count)}.`);
  for (const v of unconfirmedVisitors(facts)) lines.push(`Nobody has confirmed that ${v} came this week. Never write that ${v} came or visited.`);
  if (facts.unheardDays.length > 0) {
    lines.push(`Wick heard nothing from the doorbell on ${list(facts.unheardDays)}: it cannot say who came then. Do not call the week quiet, or say anyone did not come.`);
  }
  return lines;
}

/** Said of a week with days the doorbell was not heard: what Wick cannot see is never a quiet week. */
const UNHEARD_ABSENCE = /\b(?:quiet(?:er)?|fewer|nothing (?:was |is )?unusual|nobody (?:came|has come|visited)|no ?one (?:came|has come|visited)|did not (?:come|visit)|didn['’]t (?:come|visit))\b/i;

/** Per visitor: confirmed visits, and the times the door was answered when they were expected that nobody confirmed. */
function visitorCounts(facts: WeekFacts): { name: string; confirmed: number; unconfirmed: number }[] {
  const names = [...new Set([...facts.confirmed.map((v) => v.name), ...facts.whenExpected.map((v) => v.name)])];
  return names.map((name) => {
    const confirmed = facts.confirmed.find((v) => v.name === name)?.count ?? 0;
    const atDoor = facts.whenExpected.find((v) => v.name === name)?.count ?? 0;
    return { name, confirmed, unconfirmed: Math.max(0, atDoor - confirmed) };
  });
}

/** The visitors somebody came to the door for this week, none of whose visits the resident confirmed. */
function unconfirmedVisitors(facts: WeekFacts): string[] {
  return visitorCounts(facts).filter((v) => v.confirmed === 0).map((v) => v.name);
}

const VISIT_CLAIM = /\b(?:visit(?:s|ed|ing)?|came|comes?|coming|was here|were here|stopped by|dropped (?:by|in)|popped (?:in|round|by)|called (?:in|round|by))\b/i;
const HEDGED = /\bexpected\b|\bnot (?:yet )?confirmed\b|\bunconfirmed\b|\bnobody has confirmed\b/i;

/** A sentence that says a visitor came, of a visitor nobody confirmed: the claim the door cannot make. */
function unconfirmedClaim(text: string, facts: WeekFacts): string | undefined {
  const names = unconfirmedVisitors(facts);
  if (names.length === 0) return undefined;
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    if (!VISIT_CLAIM.test(sentence) || HEDGED.test(sentence)) continue;
    if (names.some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence))) return sentence.trim();
  }
  return undefined;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, once: 1, twice: 2, thrice: 3, dozen: 12, half: 0.5,
};
const NUMBER_PATTERN = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi');

function allowedNumbers(facts: WeekFacts, deltas: readonly RhythmDelta[]): ReadonlySet<number> {
  return new Set([
    facts.doorVisits,
    ...facts.doorTimes.map((t) => t.count),
    ...facts.whenExpected.map((v) => v.count),
    ...visitorCounts(facts).flatMap((v) => [v.confirmed, v.unconfirmed]),
    ...comparisonNumbers(deltas),
  ]);
}

/**
 * `deltas` is the Rhythm baseline's answer for this week (rhythm/baseline.ts):
 * it widens the numbers the prose may use to last week's and the usual
 * week's, and it is what any talk of "usual" is held to (comparisons.ts).
 */
export function checkNarrative(text: string, facts: WeekFacts, deltas: readonly RhythmDelta[] = []): NarrativeCheck {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_NARRATIVE_CHARS) return { ok: false, reason: 'too_long', detail: String(trimmed.length) };

  const allowed = allowedNumbers(facts, deltas);
  // "no one" is nobody, not a count of one.
  const scannable = trimmed.replace(/\bno one\b/gi, 'nobody');
  for (const match of scannable.matchAll(NUMBER_PATTERN)) {
    const token = match[1]!;
    const value = NUMBER_WORDS[token.toLowerCase()] ?? Number(token);
    if (!allowed.has(value)) return { ok: false, reason: 'unsupported_number', detail: token };
  }

  const comparison = checkComparisons(trimmed, deltas);
  if (!comparison.ok) return { ok: false, reason: 'unsupported_comparison', detail: comparison.detail };

  const claim = unconfirmedClaim(trimmed, facts);
  if (claim) return { ok: false, reason: 'unconfirmed_visit', detail: claim };

  if (facts.unheardDays.length > 0) {
    // A sentence about what Wick heard is the hedge itself ("on the days Wick heard the doorbell").
    for (const sentence of trimmed.split(/(?<=[.!?;:])\s+/)) {
      if (/\bheard\b/i.test(sentence)) continue;
      const absence = UNHEARD_ABSENCE.exec(sentence);
      if (absence) return { ok: false, reason: 'unheard_absence', detail: absence[0] };
    }
  }
  return { ok: true };
}

/**
 * Why a draft was refused, said to the model on its second try. Shared by
 * the Narrator (index.ts) and the Sunday brief (graphs/weeklyBrief.ts), so
 * both ask again in the same words.
 */
export function refusalReason(check: Extract<NarrativeCheck, { ok: false }>): string {
  switch (check.reason) {
    case 'unsupported_number':
      return `Your draft used "${check.detail}", a number that is not in the facts. Use only the numbers given.`;
    case 'unsupported_comparison':
      return `Your draft said "${check.detail}", which the facts do not support. Compare with last week, or with what is usual, only where the facts do.`;
    case 'unheard_absence':
      return `Your draft said "${check.detail}", but the doorbell was not heard on some days of the week. Do not call the week quiet or say anyone did not come.`;
    case 'unconfirmed_visit':
      return `Your draft said "${check.detail}", but nobody confirmed who came. Say that someone came to the door when they were expected, as the facts do.`;
    case 'too_long':
      // The number and the overshoot: "stay under the limit" alone left the second draft as long as the first.
      return `Your draft was ${check.detail} characters, ${Number(check.detail) - MAX_NARRATIVE_CHARS} over the limit of ${MAX_NARRATIVE_CHARS}. Cut a clause or a sentence.`;
    default:
      return 'Your draft was empty.';
  }
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Sentences from the facts alone, door first then who visited, each part
 * included only if asked for, and all of it — with `tail` — inside the card.
 * `comparisons` (this week against the usual) come after the names and
 * before the door's times of day: "nothing unusual" is worth more than
 * "twice on Wednesday evening".
 */
function compose(
  facts: WeekFacts,
  include: { door: boolean; visits: boolean },
  tail: readonly string[] = [],
  comparisons: readonly string[] = [],
): string[] {
  const unheard = facts.unheardDays.length > 0;
  // The days the doorbell went unheard are said first after the door, and claim their room before anything else.
  // With the door kept private they are not said at all — they are about the door — but the week is still never called quiet.
  const notHeard = unheard && include.door ? [`Wick heard nothing from the doorbell on ${list(facts.unheardDays)}, so it cannot say who came then.`] : [];
  const fits = (sentences: readonly string[]) => [...notHeard, ...sentences, ...tail].join(' ').length <= MAX_NARRATIVE_CHARS;

  let door: string | undefined;
  if (include.door) {
    if (facts.doorVisits === 0 && unheard) {
      // Not a quiet week: a week Wick could not fully see.
      door = 'Nobody came to the front door on the days Wick heard the doorbell.';
    } else if (facts.doorVisits === 0) {
      door = facts.weekComplete ? 'A quiet week. Nobody came to the front door.' : 'A quiet week so far. Nobody has come to the front door since Monday.';
    } else {
      door = `Someone came to the front door ${spokenTimes(facts.doorVisits)} ${facts.weekComplete ? 'this week' : 'so far this week'}.`;
    }
  }

  // Who visited matters more than when the door was busy, so names claim
  // their room first and the time-of-day breakdown gets whatever is left.
  // Only a visit she confirmed says who came; the door when someone was
  // expected says only that somebody did.
  const named: string[] = [];
  // With the door kept private, the visitor's sentence does not speak of the door either.
  const came = include.door ? 'came to the door' : 'came';
  if (include.visits) {
    for (const v of visitorCounts(facts)) {
      const sentences = [
        ...(v.confirmed > 0 ? [`${v.name} came ${spokenTimes(v.confirmed)}, as confirmed on the television.`] : []),
        ...(v.unconfirmed > 0
          ? [v.confirmed > 0
            ? `Someone ${came} ${spokenTimes(v.unconfirmed)} more when ${v.name} was expected, not confirmed.`
            : `Someone ${came} ${spokenTimes(v.unconfirmed)} when ${v.name} was expected.`]
          : []),
      ];
      for (const sentence of sentences) {
        if (fits([...(door ? [door] : []), ...named, sentence])) named.push(sentence);
      }
    }
  }

  const compared: string[] = [];
  for (const sentence of comparisons) {
    if (fits([...(door ? [door] : []), ...named, ...compared, sentence])) compared.push(sentence);
  }

  if (door && facts.doorVisits > 0 && facts.doorTimes.length > 0) {
    const [only] = facts.doorTimes;
    const detailed =
      facts.doorTimes.length === 1 && only
        ? `${door.slice(0, -1)}, on ${only.day} ${only.part}.`
        : `${door.slice(0, -1)}: ${list(facts.doorTimes.map((t) => `${spokenTimes(t.count)} on ${t.day} ${t.part}`))}.`;
    if (fits([detailed, ...named, ...compared])) door = detailed;
  }

  return [...(door ? [door] : []), ...notHeard, ...named, ...compared, ...tail];
}

/** The week from the facts alone — no model, nothing invented. Always passes checkNarrative. */
export function fallbackNarrative(facts: WeekFacts, deltas: readonly RhythmDelta[] = []): string {
  return compose(facts, { door: true, visits: true }, [], comparisonSentences(deltas, facts.weekComplete, { unheard: facts.unheardDays.length > 0 })).join(' ');
}

/**
 * The family's week when the resident keeps part of it private ("What
 * Sarah sees"). What is hidden is left out, never reported as absent: a
 * private door is not "nobody came". The last sentence says some of the
 * week is private, because silence would be a lie (§6.4).
 */
export function privateNarrative(
  facts: WeekFacts,
  hidden: { readonly door: boolean; readonly visits: boolean },
  deltas: readonly RhythmDelta[] = [],
): string {
  const include = { door: !hidden.door, visits: !hidden.visits };
  if (!include.door && !include.visits) return 'This week is kept private.';
  // Only what is still shared is compared, and never the week as a whole:
  // "nothing unusual" would speak for the part being kept back.
  const comparisons = comparisonSentences(visibleDeltas(deltas, hidden), facts.weekComplete, { wholeWeek: false, unheard: facts.unheardDays.length > 0 });
  return compose(facts, include, ['Some of this week is kept private.'], comparisons).join(' ');
}
