/**
 * Hand a household that existed before accounts did to its first organiser.
 *
 * Until accounts, this deployment served one household whose id was written
 * into the code (`margaret`). Its timeline, weekly stories, roster and Ring
 * link are all filed under that id, so the person who runs it should become
 * its organiser rather than start an empty household beside it.
 *
 *   1. Sign up in the family app first (the account must exist).
 *   2. AWS_PROFILE=wick-dev TABLE_NAME=wick \
 *        npx vite-node -c vitest.config.ts scripts/adopt-household.ts -- \
 *        --household margaret --email you@example.com --resident Margaret
 *   3. Open Wick on the television: the resident is asked, like for anyone
 *      else, whether to allow you (INV-9). This script cannot answer for them.
 *   4. In the family app, sign out and sign in again, and pick the household.
 *
 * It also files each already-paired television under its device id, which
 * is how a television is looked up since INV-8 (device-owner.mjs). Without
 * that, a television paired before accounts shows the pairing screen again.
 *
 * Refuses a household that already has an organiser. Safe to run twice.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendToDevice } from '@wick/agent';
import { adoptHousehold } from '../services/mcp-server/src/accounts/circle.ts';
import { createDynamoAccountStore, HouseholdExistsError, type DdbSend } from '../services/mcp-server/src/accounts/store.ts';
import { randomId } from '../services/mcp-server/src/accounts/tokens.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const TABLE = process.env.TABLE_NAME;
const householdId = arg('household');
const email = arg('email');
const residentName = arg('resident');

if (!TABLE || !householdId || !email || !residentName) {
  console.error('Usage: TABLE_NAME=wick vite-node scripts/adopt-household.ts -- --household <id> --email <account email> --resident <their name>');
  process.exit(1);
}

const ddb = new DynamoDBClient({});
const store = createDynamoAccountStore(((command) => ddb.send(command as never)) as DdbSend, TABLE);

const user = await store.findUserByEmail(email);
if (!user) {
  console.error(`No Wick account for ${email}. Sign up in the family app first, then run this again.`);
  process.exit(1);
}

try {
  const household = await adoptHousehold(
    { store, sendCard: (card) => sendToDevice(card, DEFAULT_POLICY), now: Date.now, newId: randomId },
    { userId: user.userId, email: user.email, name: user.name },
    { householdId, residentName },
  );
  console.log(`${user.name} is now the organiser of "${household.name}" (${household.householdId}), waiting for ${household.residentName} to allow it on the television.`);
} catch (err) {
  if (!(err instanceof HouseholdExistsError)) throw err;
  console.log(`${householdId} already has an organiser. Nothing changed there.`);
}

// The same item pair-claim.mjs writes for a television paired today
// (services/edge-device/lambda/device-owner.mjs claimDeviceOwner).
for (const tv of await store.listTelevisions(householdId)) {
  try {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: `DEV#${tv.deviceId}` }, sk: { S: 'META' }, householdId: { S: householdId }, claimedAt: { N: String(Date.now()) } },
      ConditionExpression: 'attribute_not_exists(pk) OR householdId = :hh',
      ExpressionAttributeValues: { ':hh': { S: householdId } },
    }));
    console.log(`television ${tv.deviceId}: filed under this household`);
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    console.log(`television ${tv.deviceId}: belongs to another household, left alone`);
  }
}
