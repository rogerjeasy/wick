/**
 * Hand a Ring doorbell or chime to a household.
 *
 * A deployment has one Ring link, and a ring carries only a device id. The
 * Door agent reads which household holds that device from
 * `RINGDEV#<deviceId>` (services/agent/src/store/ringDevices.ts); a device
 * nobody holds reaches no television. This is how a device gets a holder,
 * and it is run by whoever operates the deployment, because the Ring
 * account is theirs: nobody can claim a doorbell from the family app.
 *
 *   # every device on the linked Ring account, and who holds it
 *   AWS_PROFILE=wick-dev TABLE_NAME=wick \
 *     npx vite-node -c vitest.config.ts scripts/assign-ring-device.ts -- --list
 *
 *   # one device
 *   ... scripts/assign-ring-device.ts -- --household margaret --device ava1.ring.device.XXXX
 *
 *   # every device on the account that nobody holds yet
 *   ... scripts/assign-ring-device.ts -- --household margaret --all
 *
 * Never moves a device that another household holds. Safe to run twice.
 * Never prints the token.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { RingApiError, RingClient, listDevices, type RingDevice } from '@wick/ring';
import { loadEnv, ringToken } from './env.js';
import { ringDeviceOwners, type DdbSend } from '../services/agent/src/store/ringDevices.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

loadEnv();

const TABLE = process.env.TABLE_NAME;
const householdId = arg('household');
const deviceId = arg('device');
const list = flag('list');
const all = flag('all');

if (!TABLE || (!list && (!householdId || (!deviceId && !all)))) {
  console.error('Usage: TABLE_NAME=wick vite-node scripts/assign-ring-device.ts -- --list | --household <id> (--device <ring device id> | --all)');
  process.exit(1);
}

const ddb = new DynamoDBClient({});
const owners = ringDeviceOwners(((command) => ddb.send(command as never)) as DdbSend, TABLE);

/** The linked account's devices; `--device` never needs this, so it works without a Ring token. */
async function accountDevices(): Promise<RingDevice[]> {
  try {
    return await listDevices(new RingClient({ getToken: ringToken }));
  } catch (err) {
    if (!(err instanceof RingApiError)) throw err;
    console.error(`Ring refused the request (HTTP ${err.status}). A Playground token lasts about 30 minutes: put a fresh RING_OAUTH_TOKEN in .env, or name the device with --device.`);
    process.exit(1);
  }
}

if (list) {
  for (const device of await accountDevices()) {
    console.log(`${device.id}  ${device.name}: ${(await owners.householdOf(device.id)) ?? 'held by nobody'}`);
  }
  process.exit(0);
}

// A typo here would send a home's doorbell to a household that does not exist.
const household = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${householdId}` }, sk: { S: 'META' } } }));
if (!household.Item) {
  console.error(`No household ${householdId}. Nothing changed.`);
  process.exit(1);
}

const targets = all ? (await accountDevices()).map((d) => d.id) : [deviceId!];
for (const id of targets) {
  const assigned = await owners.assign(id, householdId!);
  console.log(assigned ? `${id}: held by ${householdId}` : `${id}: held by another household, left alone`);
}
