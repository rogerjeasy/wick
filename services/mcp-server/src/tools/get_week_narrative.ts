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
import type { HouseholdPolicy } from '@wick/policy';
import { isoWeekRange, privateNarrative, summariseWeek, visibleDeltas } from '@wick/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { withFriendlyErrors } from './errors.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
/** The household's time zone, for rewriting a week with part of it private. Same default as the Narrator's. */
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

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

export type FamilyWeekResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative }
  | { readonly status: 'private' };

/**
 * Sarah's copy of the week, honouring what the resident keeps private
 * ("What Sarah sees", services/edge-device/lambda/sharing.mjs). The week's
 * summary is itself the RHYTHM class, so keeping that private withholds the
 * whole week. Keeping door visits or visitors private drops those entries
 * from the timeline and rewrites the prose from the facts still shared;
 * the stored prose may mention them, and the model is never asked again
 * in-request (§9.3: the round trip stays a GetItem or two). The Rhythm
 * comparisons go the same way: a private door takes "more callers than
 * usual" with it, and private visitors take "Maria did not visit" — an
 * absence is as much a fact about someone as an arrival.
 */
export function familyWeek(narrative: WeekNarrative, policy: HouseholdPolicy, timeZone: string): FamilyWeekResult {
  if (!isSharedWithFamily('RHYTHM', policy)) return { status: 'private' };

  const hidden = { door: !isSharedWithFamily('DOOR_EVENT', policy), visits: !isSharedWithFamily('PRESENCE', policy) };
  if (!hidden.door && !hidden.visits) return { status: 'available', narrative };

  const hides = (kind: string) => (kind === 'door' && hidden.door) || ((kind === 'visit' || kind === 'presence') && hidden.visits);
  const timeline = narrative.timeline.filter((e) => !hides(e.kind));
  const facts = summariseWeek(timeline, { timeZone, range: isoWeekRange(narrative.isoWeek), now: narrative.generatedAt });
  // Weeks written before the baseline existed carry no deltas at all.
  const deltas = visibleDeltas(narrative.deltas ?? [], hidden);
  return {
    status: 'available',
    narrative: { ...narrative, timeline, deltas, text: privateNarrative(facts, hidden, deltas), textSource: 'facts' },
  };
}

export function registerGetWeekNarrative(mcpServer: McpServer, ddb: DynamoDBClient, ctx: ToolContext): void {
  mcpServer.registerTool(
    'get_week_narrative',
    {
      title: "This week's narrative",
      description: "Returns the precomputed weekly narrative — prose and timeline — for the household's week. Withholds a narrative the resident hasn't seen on their own television yet.",
      inputSchema: { isoWeek: z.string().optional().describe('ISO 8601 week, e.g. "2026-W38". Defaults to the current week.') },
    },
    withFriendlyErrors(gated(ctx, async (_allowed, { isoWeek }: { isoWeek?: string | undefined }) => {
      const week = isoWeek ?? currentIsoWeek();
      const result = await loadWeekNarrative(ddb, ctx.householdId, week);
      if (result.status === 'awaiting_resident') {
        return { content: [{ type: 'text' as const, text: WEEK_AWAITING_RESIDENT_TEXT }] };
      }
      if (result.status === 'not_written') {
        return { content: [{ type: 'text' as const, text: WEEK_NOT_WRITTEN_TEXT }] };
      }
      const family = familyWeek(result.narrative, await loadHouseholdPolicy(ddb, ctx.householdId), HOUSEHOLD_TZ);
      if (family.status === 'private') {
        return { content: [{ type: 'text' as const, text: FAMILY_REFUSAL_TEXT }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(family.narrative) }] };
    })),
  );
}
