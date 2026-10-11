/**
 * MCP tool: add_regular_visitor — "Maria comes on Tuesdays and Fridays at nine."
 *
 * M4. The roster is what lets the door say "this looks like Maria" and what
 * Something's Different measures a missed visit against — and until now the
 * only way onto it was a row written into the table by hand. This is the
 * way in for the family: a name, the days, a time.
 *
 * It is still a schedule and nothing more (docs/WICK.md D3): no face, no
 * photograph, no description of the person. Saying it again for the same
 * name changes that visitor's days and time; it never makes a second Maria.
 *
 * Who visits, by name, is the PRESENCE class. A resident who keeps that
 * from the family is not having it curated by them either: the tool
 * refuses, exactly as list_regular_visitors does.
 *
 * The time is given in the household's own clock and stored as the door
 * agent matches it, in UTC (services/agent/src/agents/door/roster.ts), at
 * the offset in force today. After the clocks change a regular time is an
 * hour out until it is said again.
 *
 * The door's "this looks like Maria" is only a schedule, and this tool is
 * how a schedule gets written — so what it writes is kept narrow:
 *
 *   - It stands on the word of the member who added it, and only while the
 *     resident still allows that member (`addedBy`, door/roster.ts
 *     stillWelcome): take someone out of the circle and the visitors they
 *     vouched for leave the roster with them.
 *   - Two visitors cannot be expected at the same time. The door agent
 *     takes the first entry that fits, so an overlapping one would speak
 *     over the visitor already there — or be spoken over.
 *   - Half an hour either side, and a dozen entries: a roster cannot be
 *     made to say "looks like someone" about every caller.
 */
import { z } from 'zod';
import { PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { parsePattern } from '@wick/agent';
import { describePattern, loadRoster } from './list_regular_visitors.js';
import { WRITES, data, say } from './result.js';
import { localToUtc } from './when.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

const DAY_MS = 86_400_000;
/** A ring this long either side of the usual time still looks like them. */
export const REGULAR_WINDOW_MIN = 30;
/** A roster is a handful of people the resident knows, not a contact list. */
export const MAX_REGULAR_VISITORS = 12;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
type DayName = (typeof DAY_NAMES)[number];

export const VISITOR_BAD_NAME_TEXT = 'I need the name they go by, in a word or two, like Maria.';
export const VISITOR_BAD_TIME_TEXT = 'I need the time they usually come, like nine in the morning.';
export const VISITOR_TOO_MANY_TEXT = 'There are already twelve regular visitors, which is as many as the door keeps.';

/** A name as a person would say it: letters, and the marks names have. One to forty characters. */
export function visitorName(raw: string): string | undefined {
  const name = raw.trim().replace(/\s+/g, ' ');
  return /^[\p{L}][\p{L}\p{M}' .-]{0,39}$/u.test(name) ? name : undefined;
}

/** "Maria" -> "maria", "Dr. O'Neil" -> "dr-o-neil". The roster's key for that name. */
export function personIdFor(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The pattern the door agent reads: "TUE,FRI 08:00±60m", in UTC. `time` is
 * HH:MM on the household's clock; a time that falls on the other side of
 * midnight in UTC takes its days with it.
 */
export function regularPattern(days: readonly DayName[], time: string, timeZone: string, now: Date): string | undefined {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const at = localToUtc(today, time, timeZone);
  if (at === undefined) return undefined;
  const utc = new Date(at);
  const dayShift = Math.round((Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  const codes = [...new Set(days.map((d) => (DAY_NAMES.indexOf(d) + dayShift + 7) % 7))]
    // Monday first, as a week is said.
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((i) => DAY_CODES[i]!);
  const hhmm = `${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')}`;
  return `${codes.join(',')} ${hhmm}±${REGULAR_WINDOW_MIN}m`;
}

const WEEKDAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] as const;

/**
 * The visitor already expected at a time this pattern would also claim, and
 * the day they collide on — or nothing. Two windows collide when they share
 * a day and overlap at all.
 */
export function collidesWith(pattern: string, others: readonly RosterEntry[]): { readonly name: string; readonly day: string } | undefined {
  const mine = parsePattern(pattern);
  if (!mine) return undefined;
  for (const other of others) {
    const theirs = parsePattern(other.expectedPattern);
    if (!theirs) continue;
    const day = mine.days.find((d) => theirs.days.includes(d));
    if (day === undefined) continue;
    if (Math.abs(mine.minuteOfDay - theirs.minuteOfDay) <= mine.windowMin + theirs.windowMin) return { name: other.name, day: WEEKDAYS[day]! };
  }
  return undefined;
}

export interface RegularVisitorAnswer {
  readonly added: true;
  /** True when this name was already on the roster and its days or time were changed. */
  readonly changed: boolean;
  readonly personId: string;
  readonly name: string;
  /** "Tuesday and Friday mornings". */
  readonly usualDays: string;
}

export function registerAddRegularVisitor(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'add_regular_visitor',
    {
      title: 'Add a regular visitor',
      description:
        'Puts someone who visits regularly on the household’s roster: the name they go by, the days they come and the time (the household’s local time). ' +
        'From then on, when the doorbell rings around that time on one of those days the resident’s television says who it looks like, and a visit that does not happen can be noticed. ' +
        'Saying it again for the same name changes that visitor’s days and time. It is a schedule only: never ask for or pass a description of the person.',
      inputSchema: {
        name: z.string().describe('The name the visitor goes by, e.g. "Maria".'),
        days: z.array(z.enum(DAY_NAMES)).min(1).max(7).describe('The days of the week they usually come, e.g. ["tuesday","friday"].'),
        time: z.string().describe('The time they usually come, in 24-hour HH:MM, in the household’s local time.'),
      },
      annotations: WRITES,
    },
    withFriendlyErrors(gated(ctx, async (_allowed, asked: { name: string; days: DayName[]; time: string }) => {
      if (!isSharedWithFamily('PRESENCE', await loadHouseholdPolicy(ddb, ctx.householdId))) return say(FAMILY_REFUSAL_TEXT);

      const name = visitorName(asked.name);
      const personId = name ? personIdFor(name) : '';
      // `member-…` is how an announced visit is filed (contracts memberPersonId): never a name's key.
      if (!name || !personId || personId.startsWith('member-')) return say(VISITOR_BAD_NAME_TEXT);
      const expectedPattern = regularPattern(asked.days, asked.time, HOUSEHOLD_TZ, now());
      if (!expectedPattern) return say(VISITOR_BAD_TIME_TEXT);

      const regulars = (await loadRoster(ddb, ctx.householdId)).filter((p) => !p.expectedOnce);
      const existing = regulars.find((p) => p.personId === personId);
      if (!existing && regulars.length >= MAX_REGULAR_VISITORS) return say(VISITOR_TOO_MANY_TEXT);
      const taken = collidesWith(expectedPattern, regulars.filter((p) => p.personId !== personId));
      if (taken) {
        return say(`${taken.name} is already expected around then on ${taken.day}. The door can only expect one person at a time: give another time, or change ${taken.name}’s first.`);
      }

      const entry: RosterEntry = { personId, name, expectedPattern, addedBy: ctx.userId };
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `HH#${ctx.householdId}` },
          sk: { S: `PER#${personId}` },
          data: { S: JSON.stringify(entry) },
          addedAt: { N: String(now().getTime()) },
        },
      }));

      const answer: RegularVisitorAnswer = {
        added: true,
        changed: existing !== undefined,
        personId,
        name,
        usualDays: describePattern(expectedPattern) ?? '',
      };
      return data(answer);
    })),
  );
}
