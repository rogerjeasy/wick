/**
 * Can the deployed stack see the cameras Wick has on record?
 *
 *   npm run ring:check
 *
 * Asks Ring with the token the *stack* holds (Secrets Manager,
 * wick/ring/tokens) — never the one in .env, which every other script here
 * prefers. They are different identities to Ring: a token pasted from the
 * Developer Playground sees the Playground's simulated camera, a linked
 * account's token sees that account's devices. A door picture fetched from
 * the laptop with the .env token therefore says nothing about Watch live,
 * which the stack starts with its own.
 *
 * That gap is how Watch live came to answer 404 for six days (2026-10-05 to
 * 2026-10-11): an account link had replaced the pasted token, Ring listed no
 * device for it, and every check run from a laptop still passed.
 *
 * Run it before recording, and after `scripts/set-ring-token.sh`. Exits 1
 * when a recorded camera cannot be seen. Never prints a token.
 */
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { RING_TOKEN_SECRET_ID, RingApiError, RingClient, listDevices, secretsManagerTokenProvider } from '@wick/ring';
import { loadEnv } from './env.js';
import { cameraVisibility } from './camera-visibility.js';

const short = (id: string) => (id.length > 34 ? `${id.slice(0, 26)}…${id.slice(-6)}` : id);

async function main(): Promise<void> {
  loadEnv();
  const table = process.env.TABLE_NAME ?? 'wick';

  const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: RING_TOKEN_SECRET_ID }));
  const record = JSON.parse(secret.SecretString ?? '{}') as { source?: string; expiresAt?: number; refresh_token?: string };
  const minutes = record.expiresAt ? Math.round((record.expiresAt - Date.now()) / 60000) : undefined;
  console.log(`token the stack holds: ${record.source ?? 'unlabelled'}, ${minutes === undefined ? 'no expiry recorded' : minutes > 0 ? `${minutes} min left` : `expired ${-minutes} min ago`}, ${record.refresh_token ? 'refreshed hourly' : 'cannot be refreshed'}`);

  const rows = await new DynamoDBClient({}).send(new ScanCommand({
    TableName: table,
    FilterExpression: 'begins_with(pk, :p)',
    ExpressionAttributeValues: { ':p': { S: 'RINGDEV#' } },
  }));
  const recorded = (rows.Items ?? [])
    .map((i) => ({ deviceId: (i.pk?.S ?? '').replace('RINGDEV#', ''), householdId: i.householdId?.S ?? '?' }))
    .filter((r) => r.deviceId.length > 1);

  const client = new RingClient({ getToken: secretsManagerTokenProvider() });
  let visibleIds: string[];
  try {
    visibleIds = (await listDevices(client)).map((d) => d.id);
  } catch (err) {
    const why = err instanceof RingApiError ? `Ring answered ${err.status}` : err instanceof Error ? err.message : String(err);
    console.log(`cannot ask Ring with that token: ${why}`);
    console.log('→ paste a fresh Playground token: ./scripts/set-ring-token.sh');
    process.exit(1);
  }
  console.log(`devices Ring lists for it: ${visibleIds.length}`);

  const { seen, unseen } = cameraVisibility(recorded, visibleIds);
  for (const r of seen) console.log(`  ✓ ${short(r.deviceId)} (${r.householdId})`);
  for (const r of unseen) console.log(`  ✗ ${short(r.deviceId)} (${r.householdId}) — not visible: Watch live and the door picture will fail for it`);
  if (recorded.length === 0) console.log('  no camera is assigned to any household (scripts/assign-ring-device.ts)');

  if (unseen.length > 0) {
    console.log('→ the stack is holding a token for a different Ring identity than the one these cameras belong to.');
    console.log('  For the Playground camera: paste a fresh Playground token with ./scripts/set-ring-token.sh (it lasts about 30 minutes).');
    process.exit(1);
  }
}

await main();
