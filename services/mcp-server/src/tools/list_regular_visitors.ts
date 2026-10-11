/**
 * MCP tool: list_regular_visitors — who comes to this house, and when.
 *
 * An assistant cannot ask "did the carer come?" without knowing who the
 * carer is: did_visitor_come takes a roster id, and until this tool nothing
 * told a client what ids there were. It is also where "when did Maria last
 * come?" is answered, and where a visit somebody has announced
 * (expect_visit.ts) can be seen until it is over.
 *
 * Names and days only — the roster is a schedule, never a face (door/
 * roster.ts). Who visits is the PRESENCE class: a resident who keeps that
 * to themselves keeps this list too.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp, parseTimestampFromSortKey, type RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { expectedToday } from './did_visitor_come.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { READS, data, say } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const DAY_MS = 86_400_000;
/** How far back "when did they last come" looks. */
const LAST_VISIT_DAYS = 28;

export interface RegularVisitor {
  readonly personId: string;
  readonly name: string;
  /** "Tuesday and Friday mornings" — absent when no days are known. */
  readonly usualDays?: string;
  readonly expectedToday: boolean;
  /** Absent when they have not come in the last four weeks. */
  readonly lastVisitAt?: number;
}

export interface VisitorsAnswer {
  readonly visitors: readonly RegularVisitor[];
  /** Visits somebody has said they will make, soonest first. */
  readonly expected: readonly { readonly name: string; readonly at: number }[];
}

const DAY_NAMES: Record<string, string> = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };

function partOfDay(hour: number): string {
  if (hour >= 5 && hour < 12) return 'mornings';
  if (hour >= 12 && hour < 17) return 'afternoons';
  if (hour >= 17 && hour < 22) return 'evenings';
  return 'nights';
}

/** "TUE,FRI 09:00±30m" -> "Tuesday and Friday mornings". Undefined for a pattern it cannot read. */
export function describePattern(pattern: string | undefined): string | undefined {
  const m = /^([A-Z,]+)\s+(\d{2}):\d{2}/.exec(pattern?.trim() ?? '');
  if (!m) return undefined;
  const days = m[1]!.split(',').map((code) => DAY_NAMES[code]);
  if (days.length === 0 || days.some((d) => d === undefined)) return undefined;
  const listed = days.length === 1 ? days[0]! : `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]!}`;
  return `${listed} ${partOfDay(Number(m[2]))}`;
}

export async function loadRoster(ddb: DynamoDBClient, householdId: string): Promise<RosterEntry[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'PER#' } },
  }));
  return (res.Items ?? []).flatMap((item) => (item.data?.S ? [JSON.parse(item.data.S) as RosterEntry] : []));
}

export async function loadVisitors(ddb: DynamoDBClient, householdId: string, now: Date): Promise<VisitorsAnswer> {
  const roster = await loadRoster(ddb, householdId);

  const visits = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    FilterExpression: '#t = :presence',
    ExpressionAttributeNames: { '#t': 'type' },
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTimestamp(now.getTime() - LAST_VISIT_DAYS * DAY_MS)}` },
      ':to': { S: `EVT#${padTimestamp(now.getTime())}#￿` },
      ':presence': { S: 'presence' },
    },
  }));
  const lastVisit = new Map<string, number>();
  for (const item of visits.Items ?? []) {
    const personId = item.personId?.S;
    const at = parseTimestampFromSortKey(item.sk?.S ?? '');
    if (personId && at > (lastVisit.get(personId) ?? 0)) lastVisit.set(personId, at);
  }

  const visitors: RegularVisitor[] = roster
    .filter((p) => !p.expectedOnce)
    .map((p) => {
      const usualDays = describePattern(p.expectedPattern);
      const lastVisitAt = lastVisit.get(p.personId);
      return {
        personId: p.personId,
        name: p.name,
        ...(usualDays ? { usualDays } : {}),
        expectedToday: expectedToday(p.expectedPattern, now),
        ...(lastVisitAt !== undefined ? { lastVisitAt } : {}),
      };
    });

  const expected = roster
    .flatMap((p) => (p.expectedOnce ? [{ name: p.name, at: p.expectedOnce.at, until: p.expectedOnce.at + p.expectedOnce.windowMin * 60_000 }] : []))
    .filter((v) => v.until >= now.getTime())
    .sort((a, b) => a.at - b.at)
    .map(({ name, at }) => ({ name, at }));

  return { visitors, expected };
}

export function registerListRegularVisitors(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'list_regular_visitors',
    {
      title: 'Who visits regularly',
      description:
        'Lists the people who visit this household regularly — each with the `personId` that did_visitor_come takes, the days they usually come, ' +
        'whether today is one of them, and when they last came (`lastVisitAt`, within four weeks) — and any visits somebody has announced (`expected`). ' +
        'Call this first when a question names a visitor ("Maria", "the carer") or asks when someone last came.',
      inputSchema: {},
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async () => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('PRESENCE', policy)) return say(FAMILY_REFUSAL_TEXT);
      return data(await loadVisitors(ddb, ctx.householdId, now()));
    })),
  );
}
