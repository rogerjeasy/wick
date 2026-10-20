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
import { loadRoster as loadRosterFrom, visitStore, type VisitSend } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { expectedToday } from './did_visitor_come.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { answerSchema, READS, data, say } from './result.js';

import { z } from 'zod';
import { zoneOf } from '../accounts/types.js';


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
  /** The last visit the resident confirmed on her television, within four weeks. The only "when did they last come". */
  readonly lastConfirmedVisitAt?: number;
  /** The last time somebody came to the door when they were expected, within four weeks. When, never who. */
  readonly lastDoorWhenExpectedAt?: number;
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

/**
 * The household's roster, read with its circle: an announced visit whose
 * author the resident no longer allows is not on it (door/roster.ts
 * stillWelcome — the Door agent reads the roster by the same rule).
 */
export const loadRoster = (ddb: DynamoDBClient, householdId: string): Promise<RosterEntry[]> => loadRosterFrom(ddb, TABLE, householdId);

export async function loadVisitors(ddb: DynamoDBClient, householdId: string, now: Date, timeZone: string): Promise<VisitorsAnswer> {
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
  const lastAtDoor = new Map<string, number>();
  for (const item of visits.Items ?? []) {
    const personId = item.personId?.S;
    const at = parseTimestampFromSortKey(item.sk?.S ?? '');
    if (personId && at > (lastAtDoor.get(personId) ?? 0)) lastAtDoor.set(personId, at);
  }
  // Only her "Yes, that's right" says who came (packages/contracts visit.ts).
  const lastConfirmed = new Map<string, number>();
  for (const visit of await visitStore((command) => ddb.send(command as never) as ReturnType<VisitSend>, TABLE).recent(householdId, now.getTime() - LAST_VISIT_DAYS * DAY_MS)) {
    if (visit.answer === 'confirmed' && visit.arrivedAt > (lastConfirmed.get(visit.personId) ?? 0)) lastConfirmed.set(visit.personId, visit.arrivedAt);
  }

  const visitors: RegularVisitor[] = roster
    .filter((p) => !p.expectedOnce)
    .map((p) => {
      const usualDays = describePattern(p.expectedPattern);
      const lastConfirmedVisitAt = lastConfirmed.get(p.personId);
      const lastDoorWhenExpectedAt = lastAtDoor.get(p.personId);
      return {
        personId: p.personId,
        name: p.name,
        ...(usualDays ? { usualDays } : {}),
        expectedToday: expectedToday(p.expectedPattern, now, timeZone),
        ...(lastConfirmedVisitAt !== undefined ? { lastConfirmedVisitAt } : {}),
        ...(lastDoorWhenExpectedAt !== undefined ? { lastDoorWhenExpectedAt } : {}),
      };
    });

  const expected = roster
    .flatMap((p) => (p.expectedOnce ? [{ name: p.name, at: p.expectedOnce.at, until: p.expectedOnce.at + p.expectedOnce.windowMin * 60_000 }] : []))
    .filter((v) => v.until >= now.getTime())
    .sort((a, b) => a.at - b.at)
    .map(({ name, at }) => ({ name, at }));

  return { visitors, expected };
}

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  visitors: z.array(z.strictObject({
    personId: z.string(),
    name: z.string(),
    usualDays: z.string().optional(),
    expectedToday: z.boolean(),
    lastConfirmedVisitAt: z.number().optional().describe('The last visit the resident confirmed, within four weeks.'),
    lastDoorWhenExpectedAt: z.number().optional().describe('The last time somebody came to the door when they were expected, within four weeks. Not proof it was them.'),
  })),
  expected: z.array(z.strictObject({ name: z.string(), at: z.number() })).describe('Family members who said they are coming, and when.'),
});

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
        'whether today is one of them, the last visit the resident confirmed (`lastConfirmedVisitAt`) and the last time somebody came to the door when they were expected (`lastDoorWhenExpectedAt`, not proof it was them), both within four weeks — and any visits somebody has announced (`expected`). ' +
        'Call this first when a question names a visitor ("Maria", "the carer") or asks when someone last came.',
      inputSchema: {},
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed) => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('PRESENCE', policy)) return say(FAMILY_REFUSAL_TEXT);
      return data(await loadVisitors(ddb, ctx.householdId, now(), zoneOf(allowed.household)));
    })),
  );
}
