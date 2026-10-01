/**
 * MCP tool: get_week_narrative — single GetItem over precomputed state. See §7.3.
 *
 * INV-7: the resident sees their week before the family can read it.
 * `residentSeenAt` gates readability here, not just on write. A narrative
 * that exists but hasn't been seen on the television yet is withheld, and
 * the family is told why, in so many words (§6.4: refusal is a feature,
 * never silence, never a lie). That sentence is the trust model, said out
 * loud, so it is kept apart from the plainer "no week written yet".
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
  | { readonly status: 'awaiting_resident' }
  | { readonly status: 'not_written' };

export const WEEK_AWAITING_RESIDENT_TEXT =
  "This week's story is written, and it's on the television now. The person it's about reads it first. It's yours to read once they have.";
export const WEEK_NOT_WRITTEN_TEXT = "There's no story for this week yet. Wick writes the week on Sunday evening.";

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
  if (!raw) return { status: 'not_written' };
  const narrative = JSON.parse(raw) as WeekNarrative;
  if (narrative.residentSeenAt === undefined) return { status: 'awaiting_resident' };
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
      if (result.status === 'awaiting_resident') {
        return { content: [{ type: 'text' as const, text: WEEK_AWAITING_RESIDENT_TEXT }] };
      }
      if (result.status === 'not_written') {
        return { content: [{ type: 'text' as const, text: WEEK_NOT_WRITTEN_TEXT }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.narrative) }] };
    }),
  );
}
