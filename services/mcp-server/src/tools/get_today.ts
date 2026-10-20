/**
 * MCP tool: get_today — bounded Query over the EVT# timeline. See §7.3.
 *
 * Only what the family may see: who came to the door, and who visited, each
 * gated by the household policy. How the resident uses their own television
 * (card_shown, card_action — which buttons they pressed) is never the
 * family's to see, and is left out entirely; it used to be reported verbatim
 * ("The resident chose \"watch_live\" on a card."), a raw log, against the
 * trust model's "rhythm as narrative, never as raw logs" (docs/WICK.md §8.2).
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
import { doorWhenExpected, padTimestamp as padTs, parseTimestampFromSortKey as parseTsFromSk } from '@wick/contracts';
import { DEFAULT_POLICY, type HouseholdPolicy } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { loadHouseholdPolicy, isSharedWithFamily } from './get_resident_shared_view.js';
import { withFriendlyErrors } from './errors.js';
import { answerSchema, READS, data, say } from './result.js';
import { DAY_ARGUMENT, localDayBounds, resolveRecentDay } from './when.js';
import { zoneOf } from '../accounts/types.js';

export { DAY_NOT_A_DATE_TEXT, DAY_NOT_YET_TEXT, DAY_TOO_OLD_TEXT } from './when.js';
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
      // Somebody at the door when a regular visitor was expected: when, never who (packages/contracts visit.ts).
      return event.personName ? doorWhenExpected(event.personName) : 'Someone came to the door when a regular visitor was expected.';
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
  /** The same day in words: "Tuesday 6 October 2026". */
  readonly dayInWords?: string;
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
  timeZone = 'UTC',
): Promise<TodayAnswer> {
  // The day where the house is, from its midnight to the next.
  const bounds = localDayBounds(now.getTime(), timeZone);
  const startOfDay = bounds.start;
  // Upper bound is exclusive of the next day's midnight: an event at exactly
  // 00:00:00.000 tomorrow must appear in tomorrow's results only, not both.
  const endOfDay = bounds.end - 1;

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

/** What this tool's structured content is (result.ts `answerSchema`): built once, for every request. */
const OUTPUT = answerSchema({
  date: z.string().describe('The day answered for, YYYY-MM-DD.'),
  dayInWords: z.string().describe('The same day in words: "Tuesday 6 October 2026".'),
  events: z.array(z.strictObject({ at: z.number().describe('Milliseconds since the epoch.'), summary: z.string() })),
  keptPrivate: z.array(z.string()).describe('What the resident keeps private, in plain words, named whether or not it happened.'),
});

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
        'Today when no day is given; any day of the last six weeks when one is. For "yesterday" or "on Tuesday" pass `day`, and the server works the date out; ' +
        'the answer says which day it is for (`dayInWords`): say that day, not the one you were asked for, if they differ.',
      inputSchema: {
        day: z.string().optional().describe(DAY_ARGUMENT),
        date: z.string().optional().describe('An exact day, YYYY-MM-DD, when a date was given. Leave both out for today.'),
      },
      outputSchema: OUTPUT,
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async (allowed, asked: { date?: string | undefined; day?: string | undefined }) => {
      const timeZone = zoneOf(allowed.household);
      const resolved = resolveRecentDay(asked, now(), timeZone);
      if (!resolved.ok) return say(resolved.say);

      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      const answer = await loadTodayEvents(ddb, ctx.householdId, new Date(resolved.day.start), policy, timeZone);
      return data({ date: resolved.day.date, dayInWords: resolved.day.inWords, ...answer });
    }, { looksIn: true })),
  );
}
