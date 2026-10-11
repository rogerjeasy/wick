/**
 * Can each household's own Ring link see the cameras that household holds?
 *
 *   npm run ring:check
 *
 * Asks Ring with the token the *stack* holds for each household (Secrets
 * Manager, wick/ring/tokens/<householdId>) — never the one in .env, which
 * every other script here prefers. They can be different identities to Ring:
 * a token pasted from the Developer Playground sees the Playground's
 * simulated camera, a linked account's token sees that account's devices. A
 * door picture fetched from the laptop with the .env token therefore says
 * nothing about Watch live, which the stack starts with the household's own.
 *
 * That gap is how Watch live came to answer 404 for six days (2026-10-05 to
 * 2026-10-11): an account link had replaced the pasted token, Ring listed no
 * device for it, and every check run from a laptop still passed.
 *
 * Run it before recording, and after a household connects Ring. Exits 1 when
 * a household holds a camera its link cannot see. Never prints a token.
 */
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RingApiError, listDevices, ringClientsByHousehold, ringTokenSecretId } from '@wick/ring';
import { loadEnv } from './env.js';
import { cameraVisibility } from './camera-visibility.js';

const short = (id: string) => (id.length > 34 ? `${id.slice(0, 26)}…${id.slice(-6)}` : id);

async function main(): Promise<void> {
  loadEnv();
  const table = process.env.TABLE_NAME ?? 'wick';
  const ddb = new DynamoDBClient({});
  const secrets = new SecretsManagerClient({});

  const rows = await ddb.send(new ScanCommand({
    TableName: table,
    FilterExpression: 'begins_with(pk, :p)',
    ExpressionAttributeValues: { ':p': { S: 'RINGDEV#' } },
  }));
  const recorded = (rows.Items ?? [])
    .map((i) => ({ deviceId: (i.pk?.S ?? '').replace('RINGDEV#', ''), householdId: i.householdId?.S ?? '?' }))
    .filter((r) => r.deviceId.length > 1);
  if (recorded.length === 0) {
    console.log('no household holds a camera. A home connects its own Ring link from the family app.');
    return;
  }

  const clientFor = ringClientsByHousehold({ client: secrets });
  let failures = 0;
  for (const householdId of [...new Set(recorded.map((r) => r.householdId))].sort()) {
    const mine = recorded.filter((r) => r.householdId === householdId);
    console.log(`household ${householdId}`);

    try {
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: ringTokenSecretId(householdId) }));
      const record = JSON.parse(secret.SecretString ?? '{}') as { source?: string; expiresAt?: number; refresh_token?: string };
      const minutes = record.expiresAt ? Math.round((record.expiresAt - Date.now()) / 60000) : undefined;
      console.log(`  link: ${record.source ?? 'unlabelled'}, ${minutes === undefined ? 'no expiry recorded' : minutes > 0 ? `${minutes} min left` : `expired ${-minutes} min ago`}, ${record.refresh_token ? 'refreshed hourly' : 'cannot be refreshed'}`);
    } catch {
      console.log('  link: none — this household holds cameras but has no Ring link of its own');
    }

    let visibleIds: string[];
    try {
      visibleIds = (await listDevices(clientFor(householdId))).map((d) => d.id);
    } catch (err) {
      const why = err instanceof RingApiError ? `Ring answered ${err.status}` : err instanceof Error ? err.message : String(err);
      console.log(`  cannot ask Ring for this household: ${why}`);
      failures += mine.length;
      continue;
    }

    const { seen, unseen } = cameraVisibility(mine, visibleIds);
    for (const r of seen) console.log(`  ✓ ${short(r.deviceId)}`);
    for (const r of unseen) console.log(`  ✗ ${short(r.deviceId)} — not visible: Watch live and the door picture will fail for it`);
    failures += unseen.length;
  }

  if (failures > 0) {
    console.log('→ a household is holding a camera its own Ring link cannot see.');
    console.log('  For the Playground camera: connect again from the family app with a fresh Playground token (it lasts about 30 minutes).');
    process.exit(1);
  }
}

await main();
