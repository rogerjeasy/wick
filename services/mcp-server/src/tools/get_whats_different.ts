/**
 * MCP tool: get_whats_different — D1, "Something's Different" (docs/WICK.md
 * §4.4), as the family reads it.
 *
 * What is unlike this household's own usual right now, each in one plain
 * sentence — or that nothing is. Never an alert: it is an answer to "is
 * everything all right?", told in the same register as the week.
 *
 * Nothing is decided here. The counting and every sentence are the Rhythm
 * pillar's (services/agent/src/rhythm/different.ts): against the
 * household's own last six weeks, never from fewer than three, and never by
 * a model. This file loads the six weeks, and withholds what the resident
 * does not share:
 *
 *   - Every difference is a comparison with the household's usual, which is
 *     the RHYTHM class — "the shape of the week" on the resident's own
 *     television. Keeping that private withholds the whole answer, exactly
 *     as it withholds the week (get_week_narrative's familyWeek), and
 *     nothing is read to work it out.
 *   - Within it, per class, as get_today does: a household can keep its
 *     visitors private and not its door.
 *
 * Computed on request rather than by a job. The answer is about now, and
 * six weeks of a household's events is one small query (§7.3's 500 ms).
 */
import { QueryCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp, parseTimestampFromSortKey, type TimelineEntry } from '@wick/contracts';
import { toTimelineEntry, whatsDifferent, type DifferenceKind } from '@wick/agent';
import type { HouseholdPolicy } from '@wick/policy';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gated, type ToolContext } from './context.js';
import { FAMILY_REFUSAL_TEXT, isSharedWithFamily, loadHouseholdPolicy } from './get_resident_shared_view.js';
import { loadRoster } from './list_regular_visitors.js';
import { withFriendlyErrors } from './errors.js';
import { READS, data, say } from './result.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const HOUSEHOLD_TZ = process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London';

const DAY_MS = 86_400_000;
/** The six weeks a usual day is drawn from (rhythm/baseline.ts BASELINE_WEEKS), and today. */
const LOOK_BACK_MS = (6 * 7 + 1) * DAY_MS;

const KEPT_PRIVATE = ' That is something the resident keeps to themselves.';

export interface DifferentForFamily {
  /** Whole weeks Wick has been watching this household, at most six. */
  readonly weeksObserved: number;
  /** False below three weeks: there is no usual yet. */
  readonly enoughHistory: boolean;
  /** Most worth knowing first. Empty on a usual day. */
  readonly differences: readonly { readonly kind: DifferenceKind; readonly sentence: string; readonly at: number }[];
  /** What the resident keeps private, in plain words — so "nothing different" is not read as "nothing happened". */
  readonly keptPrivate: readonly string[];
  /** The whole answer in words, to be said as it stands. */
  readonly summary: string;
}

async function loadEntries(ddb: DynamoDBClient, householdId: string, now: number): Promise<TimelineEntry[]> {
  const entries: TimelineEntry[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': { S: `HH#${householdId}` },
        ':from': { S: `EVT#${padTimestamp(now - LOOK_BACK_MS)}` },
        ':to': { S: `EVT#${padTimestamp(now)}#￿` },
      },
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    for (const item of page.Items ?? []) {
      const entry = toTimelineEntry(item);
      if (entry) entries.push(entry);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return entries;
}

/** When Wick first recorded anything for this household. A week before it is a week nobody saw. */
async function firstEventAt(ddb: DynamoDBClient, householdId: string): Promise<number | undefined> {
  const first = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'EVT#' } },
    Limit: 1,
  }));
  const sk = first.Items?.[0]?.sk?.S;
  return sk ? parseTimestampFromSortKey(sk) : undefined;
}

function summaryOf(answer: Pick<DifferentForFamily, 'weeksObserved' | 'enoughHistory' | 'differences'>): string {
  if (!answer.enoughHistory) {
    const watched = answer.weeksObserved === 0 ? 'less than a week' : answer.weeksObserved === 1 ? 'one week' : `${answer.weeksObserved} weeks`;
    return `Wick has been here for ${watched}. It needs three weeks before it knows what is usual, so it cannot yet say what is different.`;
  }
  if (answer.differences.length === 0) return 'Nothing is different from the usual today.';
  return `${answer.differences.map((d) => d.sentence).join(' ')} Nothing else is different from the usual.`;
}

/**
 * The family's answer, or `undefined` when the resident keeps the shape of
 * the week private — in which case nothing has been read to work one out.
 */
export async function loadWhatsDifferent(
  ddb: DynamoDBClient,
  householdId: string,
  now: Date,
  policy: HouseholdPolicy,
  timeZone: string = HOUSEHOLD_TZ,
): Promise<DifferentForFamily | undefined> {
  if (!isSharedWithFamily('RHYTHM', policy)) return undefined;

  const doorShared = isSharedWithFamily('DOOR_EVENT', policy);
  const presenceShared = isSharedWithFamily('PRESENCE', policy);
  const keptPrivate = [
    ...(doorShared ? [] : [`When someone comes to the door.${KEPT_PRIVATE}`]),
    ...(presenceShared ? [] : [`Who visits, by name.${KEPT_PRIVATE}`]),
  ];

  const [entries, observedSince, roster] = await Promise.all([
    loadEntries(ddb, householdId, now.getTime()),
    firstEventAt(ddb, householdId),
    // Not read at all when visitors are private: nothing about them is to be worked out, let alone said.
    presenceShared ? loadRoster(ddb, householdId) : Promise.resolve([]),
  ]);

  const counted = whatsDifferent({ entries, roster, now: now.getTime(), observedSince, timeZone });
  const differences = counted.differences
    .filter((d) => (d.factClass === 'PRESENCE' ? presenceShared : doorShared))
    .map(({ kind, sentence, at }) => ({ kind, sentence, at }));

  const answer = { weeksObserved: counted.weeksObserved, enoughHistory: counted.enoughHistory, differences };
  return { ...answer, keptPrivate, summary: summaryOf(answer) };
}

export function registerGetWhatsDifferent(
  mcpServer: McpServer,
  ddb: DynamoDBClient,
  ctx: ToolContext,
  now: () => Date = () => new Date(),
): void {
  mcpServer.registerTool(
    'get_whats_different',
    {
      title: 'What is different',
      description:
        "Says what is unlike this household's own usual right now, each in one plain sentence: a regular visitor who did not come on one of their days, " +
        'somebody at the door in the night, or a day at the door unlike the same weekday usually is. Compared with the household\'s own last six weeks, ' +
        'and nothing is called different before there are three. Use it for "is anything different", "is everything all right" or "anything I should know". ' +
        'Say `summary` as it stands. It is not an alert and must not be told as one: on most days the answer is that nothing is different.',
      inputSchema: {},
      annotations: READS,
    },
    withFriendlyErrors(gated(ctx, async () => {
      const policy = await loadHouseholdPolicy(ddb, ctx.householdId);
      const answer = await loadWhatsDifferent(ddb, ctx.householdId, now(), policy);
      return answer ? data(answer) : say(FAMILY_REFUSAL_TEXT);
    })),
  );
}
