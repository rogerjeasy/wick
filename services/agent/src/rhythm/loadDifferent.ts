/**
 * What is unlike this household's usual right now, among the things the
 * resident shares — loaded for "Shall I tell Sarah?" (agents/tell/ask.ts).
 *
 * Nothing is decided here. The counting and every sentence are
 * different.ts's: against the household's own last six weeks, never from
 * fewer than three, and never by a model. This file loads those six weeks,
 * and leaves out what the resident already keeps to themselves, so that
 * they are never asked "shall I tell?" about something they have said is
 * private:
 *
 *   - Every difference is a comparison with the household's usual, which is
 *     the RHYTHM class — "the shape of the week" on the resident's own
 *     television. Keeping that private means there is nothing to ask, and
 *     nothing is read to work anything out.
 *   - Within it, per class: a household can keep its visitors private and
 *     not its door. Who visits is then not read at all.
 *
 * Six weeks of a household's events is one small query.
 */
import { QueryCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { padTimestamp, parseTimestampFromSortKey, type TimelineEntry } from '@wick/contracts';
import { toTimelineEntry } from '../agents/narrator/timeline.js';
import { isSharedWithFamily, loadHouseholdPolicy, loadRoster } from '../store/household.js';
import { whatsDifferent, type Difference } from './different.js';

const DAY_MS = 86_400_000;
/** The six weeks a usual day is drawn from (baseline.ts BASELINE_WEEKS), and today. */
const LOOK_BACK_MS = (6 * 7 + 1) * DAY_MS;

export interface ShareableDifferences {
  /** Whole weeks Wick has been watching this household, at most six. Below three there is no usual yet. */
  readonly weeksObserved: number;
  /** Most worth knowing first. Empty on a usual day. */
  readonly differences: readonly Difference[];
}

async function loadEntries(ddb: DynamoDBClient, table: string, householdId: string, now: number): Promise<TimelineEntry[]> {
  const entries: TimelineEntry[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: table,
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
async function firstEventAt(ddb: DynamoDBClient, table: string, householdId: string): Promise<number | undefined> {
  const first = await ddb.send(new QueryCommand({
    TableName: table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': { S: `HH#${householdId}` }, ':prefix': { S: 'EVT#' } },
    Limit: 1,
  }));
  const sk = first.Items?.[0]?.sk?.S;
  return sk ? parseTimestampFromSortKey(sk) : undefined;
}

/** The differences the resident could be asked about, or `undefined` when they keep the shape of the week private. */
export async function loadShareableDifferences(
  ddb: DynamoDBClient,
  table: string,
  householdId: string,
  now: number,
  timeZone: string,
): Promise<ShareableDifferences | undefined> {
  const policy = await loadHouseholdPolicy(ddb, table, householdId);
  if (!isSharedWithFamily('RHYTHM', policy)) return undefined;

  const doorShared = isSharedWithFamily('DOOR_EVENT', policy);
  const presenceShared = isSharedWithFamily('PRESENCE', policy);

  const [entries, observedSince, roster] = await Promise.all([
    loadEntries(ddb, table, householdId, now),
    firstEventAt(ddb, table, householdId),
    // Not read at all when visitors are private: nothing about them is to be worked out, let alone asked about.
    presenceShared ? loadRoster(ddb, table, householdId) : Promise.resolve([]),
  ]);

  const counted = whatsDifferent({ entries, roster, now, observedSince, timeZone });
  return {
    weeksObserved: counted.weeksObserved,
    differences: counted.differences.filter((d) => (d.factClass === 'PRESENCE' ? presenceShared : doorShared)),
  };
}
