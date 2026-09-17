/**
 * Seeds stub household/narrative/roster/timeline data for MCP Inspector
 * testing — S4a's own exit criterion is "get_week_narrative over stub data"
 * (docs/WICK-TECHNICAL.md §15 Step 2), because the real Narrator/Day/Door
 * agents that would populate this for real don't exist yet (later phases).
 *
 * This is a standalone dev script, not runtime code — see this plan's
 * Global Constraints for why it doesn't trip check:no-mocks.
 *
 * EVT# sort keys must be built exactly like packages/contracts/src/timeline.ts's
 * `padTimestamp` (the shared source of truth, imported below as `padTs`): the
 * real production writer (services/edge-device/lambda/route.mjs) never writes
 * a separate `at` attribute, and both `get_today` and `did_visitor_come` now
 * read the timestamp only out of the sort key. An `at` attribute is written
 * below too, but only for readability of raw DynamoDB output — the read side
 * ignores it entirely, so the sort key's own digits are what actually matter.
 *
 *   npm run demo:mcp-seed
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { currentIsoWeek, padTimestamp as padTs, type WeekNarrative, type RosterEntry } from '@wick/contracts';
import { loadEnv } from './env.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID ?? 'dev-household';

async function seedHouseholdPolicy(ddb: DynamoDBClient): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: 'META' },
      policy: { S: JSON.stringify(DEFAULT_POLICY) },
    },
  }));
  console.log('seeded household policy');
}

async function seedRoster(ddb: DynamoDBClient): Promise<void> {
  const maria: RosterEntry = {
    personId: 'maria',
    name: 'Maria',
    expectedPattern: `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][new Date().getUTCDay()]} 09:00±30m`,
  };
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `PER#${maria.personId}` },
      data: { S: JSON.stringify(maria) },
    },
  }));
  console.log('seeded roster entry: maria');
}

async function seedTodayTimeline(ddb: DynamoDBClient): Promise<void> {
  const now = Date.now();
  const doorAt = now - 3 * 3600_000;
  const presenceAt = now - 2 * 3600_000;

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `EVT#${padTs(doorAt)}#seed-door` },
      type: { S: 'door' },
      at: { N: String(doorAt) },
    },
  }));

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `EVT#${padTs(presenceAt)}#seed-presence` },
      type: { S: 'presence' },
      personId: { S: 'maria' },
      personName: { S: 'Maria' },
      at: { N: String(presenceAt) },
    },
  }));
  console.log('seeded today timeline: 1 door event, 1 presence event (maria)');
}

async function seedWeekNarrative(ddb: DynamoDBClient): Promise<void> {
  const isoWeek = currentIsoWeek();
  const narrative: WeekNarrative = {
    householdId: HOUSEHOLD_ID,
    isoWeek,
    text: 'A quiet week. Maria visited as usual, and there was one delivery at the door.',
    deltas: [],
    timeline: [
      { at: Date.now() - 86_400_000, kind: 'visit', summary: 'Maria visited, as usual.', personId: 'maria' },
      { at: Date.now() - 3 * 3600_000, kind: 'door', summary: 'A delivery arrived at the front door.' },
    ],
    generatedAt: Date.now() - 3600_000,
    residentSeenAt: Date.now() - 1800_000,
  };
  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${HOUSEHOLD_ID}` },
      sk: { S: `NARR#${isoWeek}` },
      data: { S: JSON.stringify(narrative) },
    },
  }));
  console.log(`seeded week narrative for ${isoWeek} (residentSeenAt set — visible to family)`);
}

async function main(): Promise<void> {
  // Before any AWS client exists: .env is applied and the credential source is
  // named, so a failure says where it looked rather than "any providers".
  const aws = loadEnv();
  console.log(`aws: ${aws.detail}`);

  const ddb = new DynamoDBClient({});

  await seedHouseholdPolicy(ddb);
  await seedRoster(ddb);
  await seedTodayTimeline(ddb);
  await seedWeekNarrative(ddb);
  console.log(`\ndone. Household: ${HOUSEHOLD_ID}. Table: ${TABLE}.`);
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  process.exit(1);
});
