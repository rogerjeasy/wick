/**
 * MCP tool: did_visitor_come — single GetItem + two bounded Queries. See §7.3.
 *
 * Carer/visitor verification (M5). Schedule-based, not biometric (D3, §5.2):
 * the roster's `expectedPattern` is a day-of-week/time expectation
 * ("TUE,FRI 09:00±30m"), matched against whether a presence EVT# row for this
 * personId exists that day — not face recognition.
 *
 * That row says somebody came to the door when the visitor was expected,
 * never who: a courier in the carer's hour writes the same one. So the
 * answer keeps the two apart (packages/contracts visit.ts): `confirmed` only
 * when the resident said "Yes, that's right" about that day's visit on her
 * television, and `doorWhenExpected` for the door alone. There is no plain
 * "visited": nothing the door sees can say it.
 *
 * Reads the same EVT#<ts>#<ulid> entity get_today.ts reads. route.mjs
 * (services/edge-device/lambda/route.mjs) never writes a separate `at`
 * attribute on the EVT# rows it writes today (card_shown/card_action) — the
 * timestamp lives ONLY in the sort key, as
 * `EVT#<15-digit-zero-padded-ms>#<uuid>`. No real writer exists yet for
 * `presence` rows (Task 7's seed script will be first), so this follows
 * get_today.ts's already-verified pattern rather than assuming a distinct
 * `at` attribute that no production writer produces: `at` is parsed back out
 * of the sort key here too.
 */
import { z } from 'zod';
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { localDayCode, localDayStart, localMinuteOfDay, padTimestamp as padTs, parseTimestampFromSortKey as parseTsFromSk, type RosterEntry } from '@wick/contracts';
import { visitStore, type VisitSend } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { loadHouseholdPolicy, isSharedWithFamily, FAMILY_REFUSAL_TEXT } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { DAY_ARGUMENT, localDayBounds, resolveRecentDay } from './when.js';
import { zoneOf } from '../accounts/types.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface VisitorCheckResult {
  /** The resident confirmed on her television that they came that day. The only answer that says who came. */
  readonly confirmed: boolean;
  /** Somebody came to the door when they were expected that day. When, never who. */
  readonly doorWhenExpected: boolean;
  /** The confirmed visit's arrival; else the first time somebody came to the door when they were expected. */
  readonly at?: number;
  readonly name: string | undefined;
  readonly expectedToday: boolean;
  /**
   * The visitor was expected that day and their usual time is over, by the
   * house's clock, when asked: "not yet" is no longer the answer (seen
   * 2026-10-20: at a quarter to seven in the evening, "Not yet. Maria is
   * usually expected today." about her morning visit).
   */
  readonly usualTimeOver: boolean;
}

/** The end of a pattern's window, in minutes of the day: "TUE,FRI 09:00±30m" ends at 09:30. */
function windowEndMinute(pattern: string | undefined): number | undefined {
  const m = /^\S+\s+(\d{2}):(\d{2})±(\d+)m$/.exec(pattern?.trim() ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) : undefined;
}

/** Whether, asked at `askedAt`, a visitor expected on the day that starts at `dayStart` has had their usual time. */
export function usualTimeOver(pattern: string | undefined, dayStart: Date, askedAt: number, timeZone: string): boolean {
  if (!expectedToday(pattern, dayStart, timeZone)) return false;
  const end = windowEndMinute(pattern);
  if (end === undefined) return false;
  // A day before today is over; today is over once the window has closed.
  if (localDayStart(askedAt, timeZone) > localDayStart(dayStart.getTime(), timeZone)) return true;
  return localMinuteOfDay(askedAt, timeZone) > end;
}

/** Whether the pattern's days include the day `now` is where the house is (`timeZone`; issue #84). */
export function expectedToday(pattern: string | undefined, now: Date, timeZone: string): boolean {
  if (!pattern) return false;
  const todayCode = localDayCode(now.getTime(), timeZone);
  const days = pattern.split(' ')[0]?.split(',') ?? [];
  return days.includes(todayCode);
}

export async function checkVisitor(
  ddb: DynamoDBClient,
  householdId: string,
  personId: string,
  now: Date,
  timeZone = 'UTC',
  askedAt: number = now.getTime(),
): Promise<VisitorCheckResult> {
  const rosterRes = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `PER#${personId}` } },
  }));
  const raw = rosterRes.Item?.data?.S;
  if (!raw) return { confirmed: false, doorWhenExpected: false, name: undefined, expectedToday: false, usualTimeOver: false };
  const roster = JSON.parse(raw) as RosterEntry;

  // The day where the house is, from its midnight to the next.
  const bounds = localDayBounds(now.getTime(), timeZone);
  const startOfDay = bounds.start;
  // Upper bound is exclusive of the next day's midnight — same off-by-one fix
  // as get_today.ts's identical BETWEEN range (an event at exactly
  // 00:00:00.000 tomorrow must not double-count into today's results).
  const endOfDay = bounds.end - 1;

  const evtRes = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    // Restricts to actual presence rows carrying this personId, not any EVT#
    // row that happens to reuse the attribute name for a different event kind.
    FilterExpression: 'personId = :pid AND #t = :presenceType',
    ExpressionAttributeNames: { '#t': 'type' },
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
      ':pid': { S: personId },
      ':presenceType': { S: 'presence' },
    },
  }));

  const atDoor = evtRes.Items?.[0];
  // Her answer about the visit that began that day: only "Yes, that's right" says who came.
  const confirmedVisit = (await visitStore((command) => ddb.send(command as never) as ReturnType<VisitSend>, TABLE).recent(householdId, startOfDay))
    .find((visit) => visit.personId === personId && visit.arrivedAt <= endOfDay && visit.answer === 'confirmed');
  const at = confirmedVisit?.arrivedAt ?? (atDoor ? parseTsFromSk(atDoor.sk?.S ?? '') : undefined);
  return {
    confirmed: Boolean(confirmedVisit),
    doorWhenExpected: Boolean(atDoor),
    ...(at !== undefined ? { at } : {}),
    name: roster.name,
    // `now` is the start of the day asked, where the house is (when.ts): its weekday is read there.
    expectedToday: expectedToday(roster.expectedPattern, now, timeZone),
    usualTimeOver: usualTimeOver(roster.expectedPattern, now, askedAt, timeZone),
  };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  confirmed: z.boolean().describe('The resident confirmed on their own television that this visitor came that day. The only answer that says who came.'),
  doorWhenExpected: z.boolean().describe('Somebody came to the door when this visitor was expected that day. Not proof it was them: never say they came on this alone.'),
  at: z.number().optional().describe('Milliseconds since the epoch: the confirmed visit, else when somebody came to the door when they were expected. Absent when neither.'),
  name: z.string().optional().describe('Absent for an id this household does not know.'),
  expectedToday: z.boolean().describe('Whether that day is one of their usual days.'),
  usualTimeOver: z.boolean().describe('They were expected that day and their usual time has passed: "not yet" is no longer the answer. With neither `confirmed` nor `doorWhenExpected`, nobody came to the door at their usual time.'),
  date: z.string().describe('The day answered for, YYYY-MM-DD.'),
  dayInWords: z.string(),
});

export function registerDidVisitorCome(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'did_visitor_come',
    {
      title: 'Did a visitor come',
      description:
        'Checks a specific regular visitor on a given day — today unless one is named: whether the resident confirmed on their television that the visitor came (`confirmed`), whether somebody came to the door when the visitor was expected (`doorWhenExpected`, which says when, never who), and whether that is one of their usual days (`expectedToday`). ' +
        'Say the visitor came only when `confirmed` is true. With only `doorWhenExpected`, say somebody came to the door at that time and that the resident has not confirmed it was them. ' +
        'With neither, say "not yet" only while `usualTimeOver` is false; once it is true, say nobody came to the door at their usual time. ' +
        'Takes the `personId` from list_regular_visitors; `name` comes back empty for an id this household does not know. ' +
        'For "on Tuesday" or "yesterday" pass `day`; the answer says which day it is for (`dayInWords`).',
      inputSchema: {
        personId: z.string().describe('The visitor’s `personId` from list_regular_visitors, e.g. "maria".'),
        day: z.string().optional().describe(DAY_ARGUMENT),
        date: z.string().optional().describe('An exact day, YYYY-MM-DD, when a date was given. Leave both out for today.'),
      },
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, { personId, day, date }: { personId: string; day?: string | undefined; date?: string | undefined }) => {
      // Mirrors get_resident_shared_view.ts's disclosure check: if PRESENCE
      // isn't shared with FAMILY under the household's policy, the whole
      // answer is withheld rather than silently answered anyway (§6.4).
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('PRESENCE', policy)) {
        return say(FAMILY_REFUSAL_TEXT);
      }
      // The same days get_today answers for, by the same rule (when.ts).
      const timeZone = zoneOf(allowed.household);
      const resolved = resolveRecentDay({ day, date }, now(), timeZone);
      if (!resolved.ok) return say(resolved.say);
      const result = await checkVisitor(ddb, ctx.householdId, personId, new Date(resolved.day.start), timeZone, now().getTime());
      return data({ ...result, date: resolved.day.date, dayInWords: resolved.day.inWords });
    })),
  );
}
