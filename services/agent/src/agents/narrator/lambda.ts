/**
 * Weekly schedule entrypoint — computes and writes the current ISO week's
 * narrative for every household with a television. Thin composition,
 * matches services/agent/src/agents/door/lambda.ts's own convention: the
 * logic worth testing lives in narrateEveryHousehold (everyHousehold.ts)
 * and computeWeekNarrative (index.ts), this only wires real AWS/Bedrock
 * clients to them and is left untested the same way door/lambda.ts's
 * handler is.
 *
 * Runs weekly (Sunday evening UTC, infra/narrator.tf) against the week
 * that's ending, not a rolling window — matches
 * docs/WICK-TECHNICAL.md §5.1's "runs weekly, offline. Cost is
 * irrelevant." A mid-week "how's Mum been" question reads last week's
 * completed narrative until the current week's own Sunday run.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { currentIsoWeek, padTimestamp, type WeekNarrative } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { householdsWithTelevision, narrateEveryHousehold } from './everyHousehold.js';
import { writeNarrative } from './prose.js';
import type { WeekRange } from './isoWeek.js';
import { sendToDevice } from '../../egress.js';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';

async function loadEvents(householdId: string, range: WeekRange) {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':from': { S: `EVT#${padTimestamp(range.startMs)}` },
      // range.endMs is exclusive; the sentinel character sorts after any
      // uuid suffix at that millisecond, matching get_today.ts's and
      // did_visitor_come.ts's identical upper-bound pattern.
      ':to': { S: `EVT#${padTimestamp(range.endMs - 1)}#￿` },
    },
  }));
  return res.Items ?? [];
}

/**
 * A Scan, filtered to paired televisions. There is no index of households,
 * and this runs once a week, offline, where a full read of the table is
 * cheap; a sparse index over DEV# rows is the answer once it is not.
 */
async function listHouseholds(): Promise<string[]> {
  const items: Record<string, AttributeValue>[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'begins_with(pk, :hh) AND begins_with(sk, :dev)',
      ExpressionAttributeValues: { ':hh': { S: 'HH#' }, ':dev': { S: 'DEV#' } },
      ProjectionExpression: 'pk, sk',
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }));
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return householdsWithTelevision(items);
}

async function saveNarrative(narrative: WeekNarrative): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${narrative.householdId}` },
      sk: { S: `NARR#${narrative.isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
}

export const handler = async (): Promise<void> => {
  const isoWeek = currentIsoWeek(new Date());

  const run = await narrateEveryHousehold(isoWeek, {
    listHouseholds,
    loadEvents,
    writeNarrative: (facts, retryReason) => writeNarrative(facts, retryReason),
    saveNarrative,
    sendWeekCard: (card) => sendToDevice(card, DEFAULT_POLICY),
    now: Date.now,
    newCorrelationId: randomUUID,
    timeZone: process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London',
    ...(process.env.WICK_FAMILY_NAME ? { familyName: process.env.WICK_FAMILY_NAME } : {}),
  });

  // A failed household is logged by name above and not rethrown: a thrown
  // handler makes EventBridge run the whole week again for every home.
  console.log(JSON.stringify({ level: run.failed.length ? 'warn' : 'info', msg: 'narrator_run', isoWeek, written: run.written.length, failed: run.failed.length }));
};
