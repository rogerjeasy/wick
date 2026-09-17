/**
 * M4 Known Visitors — schedule only, deliberately.
 *
 * "This looks like Maria — she usually comes Tuesdays" is a decision made
 * from the door event's timestamp against a roster entry's expected
 * pattern, never from the visitor's face. Ring gives third-party developers
 * no facial-recognition signal, and the product rules it out even if it
 * did (D3, docs/WICK.md §4.3 M4): "an explicitly opt-in roster... never
 * applied to strangers, never used to build a profile of anyone." basis is
 * always 'schedule' here — VisitorMatch's 'roster_face' variant exists in
 * the type for a future nobody has decided to build.
 *
 * SCHEDULE_MATCH_CONFIDENCE is a fixed, documented constant rather than a
 * computed probability: there is no real accuracy data to calibrate a
 * gradient against (that needs S6 Rhythm's historical baseline, which does
 * not exist yet), and inventing precise-looking decimals from nothing is
 * exactly the "confident guessing" docs/WICK.md Principle 11 forbids.
 */
import type { RosterEntry, VisitorMatch } from '@wick/contracts';

/** Deliberately modest: a schedule match is weaker evidence than a direct observation. */
export const SCHEDULE_MATCH_CONFIDENCE = 0.5;

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

interface ParsedPattern {
  readonly days: readonly string[];
  readonly hour: number;
  readonly minute: number;
  readonly windowMin: number;
}

/** "TUE,FRI 09:00±30m" — the same shape did_visitor_come.ts's roster already uses. */
function parsePattern(pattern: string): ParsedPattern | undefined {
  const [dayPart, timePart] = pattern.trim().split(/\s+/);
  if (!dayPart || !timePart) return undefined;

  const m = /^(\d{2}):(\d{2})±(\d+)m$/.exec(timePart);
  if (!m) return undefined;

  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;

  return { days: dayPart.split(','), hour, minute, windowMin: Number(m[3]) };
}

/**
 * Who the door event's timestamp best fits, against the household's roster —
 * or nobody, which is the common and correct answer. The first roster entry
 * that fits wins; two people scheduled at overlapping times is a household
 * curation problem, not something to adjudicate here.
 */
export function matchVisitor(roster: readonly RosterEntry[], at: number): VisitorMatch | undefined {
  const date = new Date(at);
  const todayCode = DAY_CODES[date.getUTCDay()]!;
  const minutesOfDay = date.getUTCHours() * 60 + date.getUTCMinutes();

  for (const person of roster) {
    if (!person.expectedPattern) continue;
    const parsed = parsePattern(person.expectedPattern);
    if (!parsed) continue;
    if (!parsed.days.includes(todayCode)) continue;

    const targetMinutes = parsed.hour * 60 + parsed.minute;
    if (Math.abs(minutesOfDay - targetMinutes) > parsed.windowMin) continue;

    return {
      personId: person.personId,
      name: person.name,
      basis: 'schedule',
      expectedToday: true,
      confidence: SCHEDULE_MATCH_CONFIDENCE,
    };
  }

  return undefined;
}
