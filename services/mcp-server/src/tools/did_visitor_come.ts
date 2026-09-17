/**
 * MCP tool: did_visitor_come — single GetItem + bounded Query. See §7.3.
 *
 * Carer/visitor verification (M5). Schedule-based, not biometric (D3, §5.2):
 * the roster's `expectedPattern` is a day-of-week/time expectation
 * ("TUE,FRI 09:00±30m"), matched against whether a presence EVT# row for this
 * personId exists today — not face recognition.
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
import type { RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface VisitorCheckResult {
  readonly visited: boolean;
  readonly at?: number;
  readonly name: string | undefined;
  readonly expectedToday: boolean;
}

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

function expectedToday(pattern: string | undefined, now: Date): boolean {
  if (!pattern) return false;
  // getUTCDay() is always 0-6, so this index always hits — the `!` just
  // routes around noUncheckedIndexedAccess, which can't see that bound.
  const todayCode = DAY_CODES[now.getUTCDay()]!;
  const days = pattern.split(' ')[0]?.split(',') ?? [];
  return days.includes(todayCode);
}

/** Zero-padded to 15 digits, matching route.mjs's EVT# sort key exactly. */
function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

/** Parses the ms timestamp embedded in an `EVT#<15-digit>#<uuid>` sort key. */
function parseTsFromSk(sk: string): number {
  const match = /^EVT#(\d{15})#/.exec(sk);
  return match ? Number(match[1]) : 0;
}

export async function checkVisitor(
  ddb: DynamoDBClient,
  householdId: string,
  personId: string,
  now: Date,
): Promise<VisitorCheckResult> {
  const rosterRes = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `PER#${personId}` } },
  }));
  const raw = rosterRes.Item?.data?.S;
  if (!raw) return { visited: false, name: undefined, expectedToday: false };
  const roster = JSON.parse(raw) as RosterEntry;

  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endOfDay = startOfDay + 86_400_000;

  const evtRes = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    FilterExpression: 'personId = :pid',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
      ':pid': { S: personId },
    },
  }));

  const visit = evtRes.Items?.[0];
  return {
    visited: Boolean(visit),
    ...(visit ? { at: parseTsFromSk(visit.sk?.S ?? '') } : {}),
    name: roster.name,
    expectedToday: expectedToday(roster.expectedPattern, now),
  };
}

export function registerDidVisitorCome(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'did_visitor_come',
    {
      title: 'Did a visitor come',
      description: 'Checks whether a specific person on the household roster visited today, and whether today was one of their expected days.',
      inputSchema: { personId: z.string().describe('The roster person id, e.g. "maria".') },
    },
    async ({ personId }) => {
      const result = await checkVisitor(ddb, HOUSEHOLD_ID, personId, new Date());
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );
}
