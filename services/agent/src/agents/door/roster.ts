/**
 * M4 Known Visitors — schedule only, deliberately.
 *
 * "This looks like Maria — she usually comes Tuesdays" is a decision made
 * from the door event's timestamp against a roster entry's expected
 * pattern, never from the visitor's face. Ring gives third-party developers
 * no facial-recognition signal, and the product rules it out even if it
 * did (docs/WICK.md §5.1 M4): "an explicitly opt-in roster... never
 * applied to strangers, never used to build a profile of anyone." basis is
 * always 'schedule' here — VisitorMatch's 'roster_face' variant exists in
 * the type for a future nobody has decided to build.
 *
 * SCHEDULE_MATCH_CONFIDENCE is a fixed, documented constant rather than a
 * computed probability: there is no real accuracy data to calibrate a
 * gradient against (the Rhythm baseline counts how often a named visitor
 * comes in a week, not how often a schedule match was the right person),
 * and inventing precise-looking decimals from nothing is
 * exactly the "confident guessing" docs/WICK.md Principle 11 forbids.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { userIdOfMemberPerson, type RosterEntry, type VisitorMatch } from '@wick/contracts';

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

  const matched = (person: RosterEntry): VisitorMatch => ({
    personId: person.personId,
    name: person.name,
    basis: 'schedule',
    expectedToday: true,
    confidence: SCHEDULE_MATCH_CONFIDENCE,
  });

  for (const person of roster) {
    // A visit somebody announced (expect_visit): the one moment they gave.
    if (person.expectedOnce && Math.abs(at - person.expectedOnce.at) <= person.expectedOnce.windowMin * 60_000) return matched(person);
    if (!person.expectedPattern) continue;
    const parsed = parsePattern(person.expectedPattern);
    if (!parsed) continue;
    if (!parsed.days.includes(todayCode)) continue;

    const targetMinutes = parsed.hour * 60 + parsed.minute;
    if (Math.abs(minutesOfDay - targetMinutes) > parsed.windowMin) continue;

    return matched(person);
  }

  return undefined;
}

/**
 * The roster, without the announced visits of anyone the resident no longer
 * allows — and without the regular visitors such a person added.
 * `memberships` are the household's `MEM#<userId>` rows.
 *
 * A visit somebody announced is filed under them (contracts memberPersonId)
 * and removed with them, but removal and announcement can cross: the row
 * can be written in the instant after its author is taken out of the
 * circle. So membership is checked again here, every time a roster is read
 * — the same rule as INV-9, where every tool call asks again. A row whose
 * author is not allowed right now is simply not on the roster.
 */
export function stillWelcome(
  roster: readonly RosterEntry[],
  memberships: readonly Record<string, AttributeValue>[],
): RosterEntry[] {
  const allowed = new Set(
    memberships.filter((m) => m.status?.S === 'allowed').map((m) => m.sk?.S?.replace(/^MEM#/, '')),
  );
  return roster.filter((person) => {
    // Their own announced visit, or a regular visitor they vouched for
    // (add_regular_visitor): either way it stands on their word, and only
    // for as long as the resident still takes it.
    const userId = userIdOfMemberPerson(person.personId) ?? person.addedBy;
    return userId === undefined || allowed.has(userId);
  });
}
