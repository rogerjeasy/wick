/**
 * The rows a week is written from, read from the one table — by the Sunday
 * brief on AgentCore (runtime/main.ts) and by the Narrator it falls back to
 * (narrator/lambda.ts), so both count the same rows.
 *
 * Every read is paged. A household's timeline holds seven weeks of events
 * and every card its television showed; the households with a television
 * are found by a Scan of the whole table. One page is not a safe assumption
 * for either.
 */
import { QueryCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ERRAND_SK_PREFIX, VISIT_SK_PREFIX, padTimestamp, parseTimestampFromSortKey } from '@wick/contracts';
import { householdsWithTelevision } from '../narrator/everyHousehold.js';
import type { WeekRange } from '../narrator/isoWeek.js';

type Item = Record<string, AttributeValue>;

export type PagedSend = (command: QueryCommand | ScanCommand) => Promise<{ Items?: Item[] | undefined; LastEvaluatedKey?: Item | undefined }>;

async function allPages(send: PagedSend, make: (startKey: Item | undefined) => QueryCommand | ScanCommand): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const page = await send(make(startKey));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/**
 * The households with a paired television (`HH#<household>` / `DEV#<id>`).
 * There is no index of households, and this runs once a week, offline,
 * where a full read of the table is cheap; a sparse index over DEV# rows is
 * the answer once it is not.
 */
export async function scanHouseholdsWithTelevision(send: PagedSend, table: string): Promise<string[]> {
  const items = await allPages(send, (startKey) => new ScanCommand({
    TableName: table,
    FilterExpression: 'begins_with(pk, :hh) AND begins_with(sk, :dev)',
    ExpressionAttributeValues: { ':hh': { S: 'HH#' }, ':dev': { S: 'DEV#' } },
    ProjectionExpression: 'pk, sk',
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  }));
  return householdsWithTelevision(items);
}

export function householdRows(send: PagedSend, table: string, householdId: string) {
  const pk = { S: `HH#${householdId}` };
  const withPrefix = (prefix: string) => allPages(send, (startKey) => new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': pk, ':prefix': { S: prefix } },
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  }));

  return {
    /**
     * The EVT# rows in `range` — for a week, its six before it too
     * (rhythm/baseline.ts baselineWindow) — and the VISIT# rows of visits
     * that began in it: a confirmed visit is the only row that says who came
     * (packages/contracts visit.ts).
     */
    loadEvents: async (range: WeekRange) => {
      const between = (prefix: string) => allPages(send, (startKey) => new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':from': { S: `${prefix}${padTimestamp(range.startMs)}` },
          // range.endMs is exclusive; the sentinel sorts after any id suffix at that millisecond.
          ':to': { S: `${prefix}${padTimestamp(range.endMs - 1)}#￿` },
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      const [events, visits] = await Promise.all([between('EVT#'), between(VISIT_SK_PREFIX)]);
      return [...events, ...visits];
    },

    /** The oldest EVT# row: sort keys are zero-padded timestamps, so the first is the first event. */
    async firstEventAt(): Promise<number | undefined> {
      const res = await send(new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': { S: 'EVT#' } },
        ProjectionExpression: 'sk',
        Limit: 1,
      }));
      const sk = res.Items?.[0]?.sk?.S;
      return sk ? parseTimestampFromSortKey(sk) : undefined;
    },

    /** The visits the family arranged (packages/contracts errand.ts). */
    loadErrands: () => withPrefix(ERRAND_SK_PREFIX),

    /** The television's activity counters, of which `power_on` is a film played (agents/brief/facts.ts). */
    loadTvActivity: () => withPrefix('RHYTHM#tv_activity#'),
  };
}
