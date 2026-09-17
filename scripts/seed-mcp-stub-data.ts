/**
 * Seeds stub household/narrative/roster/timeline data for MCP Inspector
 * testing — S4a's own exit criterion is "get_week_narrative over stub data"
 * (docs/WICK-TECHNICAL.md §15 Step 2), because the real Narrator/Day/Door
 * agents that would populate this for real don't exist yet (later phases).
 *
 * This is a standalone dev script, not runtime code — see this plan's
 * Global Constraints for why it doesn't trip check:no-mocks.
 *
 * EVT# sort keys must be built exactly like
 * services/mcp-server/src/tools/get_today.ts's `padTs`/`parseTsFromSk`: the
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
import type { WeekNarrative, RosterEntry } from '@wick/contracts';
import { loadEnv } from './env.js';

const TABLE = process.env.TABLE_NAME ?? 'wick';
const HOUSEHOLD_ID = process.env.WICK_HOUSEHOLD_ID ?? 'dev-household';

/** Zero-padded to 15 digits, matching route.mjs's EVT# sort key exactly. */
function padTs(ms: number): string {
  return String(ms).padStart(15, '0');
}

/** ISO 8601 week, matching services/mcp-server/src/tools/get_week_narrative.ts's own derivation. */
function currentIsoWeek(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

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
