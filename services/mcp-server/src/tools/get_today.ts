/**
 * MCP tool: get_today — bounded Query over the EVT# timeline. See §7.3.
 *
 * Only what the family may see: who came to the door, and who visited, each
 * gated by the household policy. How the resident uses their own television
 * (card_shown, card_action — which buttons they pressed) is never the
 * family's to see, and is left out entirely; it used to be reported verbatim
 * ("The resident chose \"watch_live\" on a card."), a raw log, against the
 * trust model's "rhythm as narrative, never as raw logs" (docs/WICK.md §6.2).
 *
 * A class the resident keeps private is left out too, timestamps and all: a
 * refusal per event still told the family exactly when someone came. It is
 * named once in `keptPrivate` instead, whether or not anything in it
 * happened today, so the answer reveals nothing about the day.
 *
 * Deterministic formatting only, no model call, matching §9.3's latency budget.
 *
 * route.mjs (services/edge-device/lambda/route.mjs) never writes a separate
 * `at` attribute on these items — the timestamp lives ONLY in the sort key,
 * as `EVT#<15-digit-zero-padded-ms>#<uuid>` (`String(deviceEvent.at).padStart(15,
 * '0')`). So `at` here is parsed back out of the sort key rather than read off
 * an item attribute that real production rows don't have.
 */
import { QueryCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp as padTs, parseTimestampFromSortKey as parseTsFromSk } from '@wick/contracts';
import { DEFAULT_POLICY, type HouseholdPolicy } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { loadHouseholdPolicy, isSharedWithFamily } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { READS, data, say } from './result.js';
import { utcDayStart } from './when.js';
import { z } from 'zod';

const TABLE = process.env.TABLE_NAME ?? 'wick';

export interface RawTimelineEvent {
  /** Any EVT# type: card_shown, card_action, door, presence, or one added later. */
  readonly type: string;
  readonly cardId?: string;
  readonly action?: string;
  readonly personName?: string;
}

/** The family's sentence for an event, or undefined for anything that is not theirs to see. */
export function summariseEvent(event: RawTimelineEvent): string | undefined {
  switch (event.type) {
    case 'door':
      return 'Someone was at the front door.';
    case 'presence':
      return event.personName ? `${event.personName} arrived.` : 'Someone arrived.';
    default:
      return undefined;
  }
}

export interface TodayEntry {
  readonly at: number;
  readonly summary: string;
}

export interface TodayAnswer {
  /** The day answered for, YYYY-MM-DD (UTC, as the timeline is filed). Set by the tool. */
  readonly date?: string;
  readonly events: readonly TodayEntry[];
  /** What the resident keeps private, in plain words, named whether or not it happened. */
  readonly keptPrivate: readonly string[];
}

const KEPT_PRIVATE = ' That is something the resident keeps to themselves.';

export async function loadTodayEvents(
  ddb: DynamoDBClient,
  householdId: string,
  now: Date,
  policy: HouseholdPolicy = DEFAULT_POLICY,
): Promise<TodayAnswer> {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Upper bound is exclusive of the next day's midnight: an event at exactly
  // 00:00:00.000 tomorrow must appear in tomorrow's results only, not both.
  const endOfDay = startOfDay + 86_400_000 - 1;

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTs(startOfDay)}` },
      ':to': { S: `EVT#${padTs(endOfDay)}#￿` },
    },
  }));

  // Gated per class, as get_resident_shared_view.ts does: a household can
  // keep visitors private but not the door, or the other way round.
  const doorShared = isSharedWithFamily('DOOR_EVENT', policy);
  const presenceShared = isSharedWithFamily('PRESENCE', policy);

  const events: TodayEntry[] = [];
  for (const item of res.Items ?? []) {
    const event: RawTimelineEvent = {
      type: item.type?.S ?? '',
      ...(item.personName?.S !== undefined && { personName: item.personName.S }),
    };
    if (event.type === 'door' && !doorShared) continue;
    if (event.type === 'presence' && !presenceShared) continue;
    const summary = summariseEvent(event);
    if (summary !== undefined) events.push({ at: parseTsFromSk(item.sk?.S ?? ''), summary });
  }

  const keptPrivate = [
    ...(doorShared ? [] : [`When someone comes to the door.${KEPT_PRIVATE}`]),
    ...(presenceShared ? [] : [`Who visits, by name.${KEPT_PRIVATE}`]),
  ];
  return { events, keptPrivate };
}

const DAY_MS = 86_400_000;
/** As far back as a day can be asked about: the weeks a usual week is drawn from (rhythm/baseline.ts). */
const DAYS_BACK = 42;

export const DAY_NOT_A_DATE_TEXT = 'I need the day as a date for that.';
export const DAY_NOT_YET_TEXT = 'That day has not come yet.';
export const DAY_TOO_OLD_TEXT = 'That is further back than I keep day by day. I can tell you about the last six weeks.';

export function registerGetToday(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'get_today',
    {
      title: 'A day’s events',
      description:
        "Returns one day's door activity and visits, in plain language, as far as the resident shares them, and names anything they keep private. " +
        'Today when no date is given; any day of the last six weeks when one is ("yesterday", "on Tuesday": pass that day as `date`).',
      inputSchema: { date: z.string().optional().describe('The day to answer for, YYYY-MM-DD. Leave out for today.') },
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (_allowed, { date }: { date?: string | undefined }) => {
      const today = now();
      const todayStart = today.getTime() - (today.getTime() % DAY_MS);
      const dayStart = date === undefined ? todayStart : utcDayStart(date);
      if (dayStart === undefined) return say(DAY_NOT_A_DATE_TEXT);
      if (dayStart > todayStart) return say(DAY_NOT_YET_TEXT);
      if (dayStart < todayStart - DAYS_BACK * DAY_MS) return say(DAY_TOO_OLD_TEXT);

      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      const answer = await loadTodayEvents(ddb, ctx.householdId, new Date(dayStart), policy);
      return data({ date: new Date(dayStart).toISOString().slice(0, 10), ...answer });
    })),
  );
}
