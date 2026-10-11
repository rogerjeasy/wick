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
 * With no week named — the overwhelmingly common case, "how's Mum been
 * this week?" — the answer is the latest week the resident has read. The
 * week is written on Sunday evening, so for six days in seven the current
 * week has no story yet; answering "not yet" all that time made the one
 * thing Wick is for unreachable. The answer says which week it is, and
 * what has become of the current one (`thisWeek`), so no client can pass
 * last week off as this one. INV-7 is unchanged: a week still waiting on
 * the television is stepped over, never read out.
 */
import { z } from 'zod';
import { GetItemCommand, QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
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
/** For a week asked for by name: it is not "this week", and Sunday evening will not bring it. */
export const WEEK_NOT_WRITTEN_THEN_TEXT = "There's no story for that week.";

/** What has become of the current week, when the week returned is an earlier one. */
export type ThisWeekStatus = 'not_written' | 'awaiting_resident';

export type LatestWeekResult =
  | { readonly status: 'available'; readonly narrative: WeekNarrative; readonly thisWeek?: ThisWeekStatus }
  | { readonly status: 'awaiting_resident' }
  | { readonly status: 'not_written' };

/**
 * The latest week the resident has read, from the household's newest
 * weeks (newest first, none later than `currentWeek`). Pure: the rule is
 * tested without a table.
 */
export function latestReadableWeek(newestFirst: readonly WeekNarrative[], currentWeek: string): LatestWeekResult {
  const current = newestFirst.find((n) => n.isoWeek === currentWeek);
  if (current?.residentSeenAt !== undefined) return { status: 'available', narrative: current };

  const earlier = newestFirst.find((n) => n.isoWeek < currentWeek && n.residentSeenAt !== undefined);
  if (earlier) return { status: 'available', narrative: earlier, thisWeek: current ? 'awaiting_resident' : 'not_written' };
  return { status: newestFirst.length ? 'awaiting_resident' : 'not_written' };
}

/** How far back to look for a week that has been read. Two months of unread weeks is not a home using Wick. */
const WEEKS_TO_LOOK_BACK = 8;

export async function loadLatestWeek(ddb: DynamoDBClient, householdId: string, currentWeek: string): Promise<LatestWeekResult> {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: 'NARR#' },
      ':to': { S: `NARR#${currentWeek}` },
    },
    ScanIndexForward: false,
    Limit: WEEKS_TO_LOOK_BACK,
  }));
  const weeks = (res.Items ?? []).flatMap((item) => (item.data?.S ? [JSON.parse(item.data.S) as WeekNarrative] : []));
  return latestReadableWeek(weeks, currentWeek);
}

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

export function registerGetWeekNarrative(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'get_week_narrative',
    {
      title: 'The week’s narrative',
      description:
        "Returns the household's weekly narrative: prose, a timeline, and how the week compares with a usual one (`deltas`). " +
        'With no week named, returns the most recent week the resident has already read on their own television; ' +
        '`thisWeek` is then set when that is not the current week ("not_written": Wick writes the week on Sunday evening; ' +
        '"awaiting_resident": it is on the television, and they read it first). ' +
        "Never returns a week the resident hasn't seen yet.",
      inputSchema: { isoWeek: z.string().optional().describe('ISO 8601 week, e.g. "2026-W38", for that exact week. Leave out for the latest week there is to read.') },
    },
    withFriendlyErrors(gated(ctx, async (_allowed, { isoWeek }: { isoWeek?: string | undefined }) => {
      const say = (text: string) => ({ content: [{ type: 'text' as const, text }] });
      const currentWeek = currentIsoWeek(now());
      const result: LatestWeekResult = isoWeek
        ? await loadWeekNarrative(ddb, ctx.householdId, isoWeek)
        : await loadLatestWeek(ddb, ctx.householdId, currentWeek);

      if (result.status === 'awaiting_resident') return say(WEEK_AWAITING_RESIDENT_TEXT);
      if (result.status === 'not_written') {
        return say(isoWeek && isoWeek !== currentWeek ? WEEK_NOT_WRITTEN_THEN_TEXT : WEEK_NOT_WRITTEN_TEXT);
      }
      const family = familyWeek(result.narrative, await loadHouseholdPolicy(ddb, ctx.householdId), HOUSEHOLD_TZ);
      if (family.status === 'private') return say(FAMILY_REFUSAL_TEXT);
      return say(JSON.stringify({ ...family.narrative, ...(result.thisWeek ? { thisWeek: result.thisWeek } : {}) }));
    })),
  );
}
