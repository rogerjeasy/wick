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
import { padTimestamp as padTs, parseTimestampFromSortKey as parseTsFromSk, type RosterEntry } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { loadHouseholdPolicy, isSharedWithFamily, FAMILY_REFUSAL_TEXT } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { READS, data, say } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface VisitorCheckResult {
  readonly visited: boolean;
  readonly at?: number;
  readonly name: string | undefined;
  readonly expectedToday: boolean;
}

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export function expectedToday(pattern: string | undefined, now: Date): boolean {
  if (!pattern) return false;
  // getUTCDay() is always 0-6, so this index always hits — the `!` just
  // routes around noUncheckedIndexedAccess, which can't see that bound.
  const todayCode = DAY_CODES[now.getUTCDay()]!;
  const days = pattern.split(' ')[0]?.split(',') ?? [];
  return days.includes(todayCode);
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
  // Upper bound is exclusive of the next day's midnight — same off-by-one fix
  // as get_today.ts's identical BETWEEN range (an event at exactly
  // 00:00:00.000 tomorrow must not double-count into today's results).
  const endOfDay = startOfDay + 86_400_000 - 1;

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

  const visit = evtRes.Items?.[0];
  return {
    visited: Boolean(visit),
    ...(visit ? { at: parseTsFromSk(visit.sk?.S ?? '') } : {}),
    name: roster.name,
    expectedToday: expectedToday(roster.expectedPattern, now),
  };
}

export function registerDidVisitorCome(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext): void {
  mcpServer.registerTool(
    'did_visitor_come',
    {
      title: 'Did a visitor come',
      description:
        'Checks whether a specific regular visitor came today, and whether today is one of their usual days. ' +
        'Takes the `personId` from list_regular_visitors; `name` comes back empty for an id this household does not know.',
      inputSchema: { personId: z.string().describe('The visitor’s `personId` from list_regular_visitors, e.g. "maria".') },
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (_allowed, { personId }: { personId: string }) => {
      // Mirrors get_resident_shared_view.ts's disclosure check: if PRESENCE
      // isn't shared with FAMILY under the household's policy, the whole
      // answer is withheld rather than silently answered anyway (§6.4).
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      if (!isSharedWithFamily('PRESENCE', policy)) {
        return say(FAMILY_REFUSAL_TEXT);
      }
      return data(await checkVisitor(ddb, ctx.householdId, personId, new Date()));
    })),
  );
}
