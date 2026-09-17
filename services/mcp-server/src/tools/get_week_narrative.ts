/**
 * MCP tool: get_week_narrative — single GetItem over precomputed state. See §7.3.
 *
 * INV-7: the resident sees their week before the family can read it.
 * `residentSeenAt` gates readability here, not just on write — a narrative
 * that exists but hasn't been shown to the resident yet must read as
 * "not yet available", never as an empty or error response (§6.4: refusal
 * is a feature, never silence, never a lie).
 *
 * The current ISO week is used when the caller doesn't name one — the
 * overwhelmingly common case ("how's mum been this week").
 */
import { z } from 'zod';
import { GetItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { currentIsoWeek, type WeekNarrative } from '@wick/contracts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { HOUSEHOLD_ID } from '../auth.js';
import { withFriendlyErrors } from './errors.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export type WeekNarrativeResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative }
  | { readonly status: 'not_yet_available' };

export async function loadWeekNarrative(
  ddb: DynamoDBClient,
  householdId: string,
  isoWeek: string,
): Promise<WeekNarrativeResult> {
  const res = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `NARR#${isoWeek}` } },
  }));
  const raw = res.Item?.data?.S;
  if (!raw) return { status: 'not_yet_available' };
  const narrative = JSON.parse(raw) as WeekNarrative;
  if (narrative.residentSeenAt === undefined) return { status: 'not_yet_available' };
  return { status: 'available', narrative };
}

export function registerGetWeekNarrative(mcpServer: McpServer, ddb: DynamoDBClient): void {
  mcpServer.registerTool(
    'get_week_narrative',
    {
      title: "This week's narrative",
      description: "Returns the precomputed weekly narrative — prose and timeline — for the household's week. Withholds a narrative the resident hasn't seen on their own television yet.",
      inputSchema: { isoWeek: z.string().optional().describe('ISO 8601 week, e.g. "2026-W38". Defaults to the current week.') },
    },
    withFriendlyErrors(async ({ isoWeek }: { isoWeek?: string | undefined }) => {
      const week = isoWeek ?? currentIsoWeek();
      const result = await loadWeekNarrative(ddb, HOUSEHOLD_ID, week);
      if (result.status === 'not_yet_available') {
        return { content: [{ type: 'text' as const, text: "This week's narrative isn't ready yet." }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.narrative) }] };
    }),
  );
}
