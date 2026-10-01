/**
 * Weekly schedule entrypoint — computes and writes the current ISO week's
 * narrative. Thin composition, matches services/agent/src/agents/door/
 * lambda.ts's own convention: the logic worth testing lives in
 * computeWeekNarrative (index.ts), this only wires real AWS/Bedrock clients
 * to it and is left untested the same way door/lambda.ts's handler is.
 *
 * Runs weekly (Sunday evening UTC, infra/narrator.tf) against the week
 * that's ending, not a rolling window — matches
 * docs/WICK-TECHNICAL.md §5.1's "runs weekly, offline. Cost is
 * irrelevant." A mid-week "how's Mum been" question reads last week's
 * completed narrative until the current week's own Sunday run.
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { currentIsoWeek, padTimestamp } from '@wick/contracts';
import { DEFAULT_POLICY } from '@wick/policy';
import { computeWeekNarrative } from './index.js';
import { writeNarrative } from './prose.js';
import { buildWeekCard } from './weekCard.js';
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

export const handler = async (): Promise<void> => {
  const householdId = process.env.WICK_HOUSEHOLD_ID;
  if (!householdId) throw new Error('WICK_HOUSEHOLD_ID not set');

  const isoWeek = currentIsoWeek(new Date());

  const narrative = await computeWeekNarrative(householdId, isoWeek, {
    loadEvents: (range) => loadEvents(householdId, range),
    writeNarrative: (facts, retryReason) => writeNarrative(facts, retryReason),
    now: Date.now,
    timeZone: process.env.WICK_HOUSEHOLD_TZ ?? 'Europe/London',
  });

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `NARR#${isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));

  // The resident's copy — INV-7. Pressing its one button is what actually
  // sets residentSeenAt (route.mjs); nothing here does that directly.
  const card = buildWeekCard(narrative, randomUUID(), Date.now());
  await sendToDevice(card, DEFAULT_POLICY);

  console.log(JSON.stringify({ level: 'info', msg: 'narrative_computed', isoWeek, events: narrative.timeline.length, textSource: narrative.textSource, chars: narrative.text.length }));
};
