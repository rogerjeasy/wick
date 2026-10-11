/**
 * Scheduled token keep-alive, for every household that has a Ring link.
 *
 * Lazy refresh alone would be enough if traffic were steady. It is not: a
 * household can go quiet for a day, and the first thing to wake the system up
 * is a doorbell press with a five-second budget — the worst possible moment to
 * discover the access token died and spend a round trip to Ring on it.
 *
 * So a schedule keeps each link warm, and `getAccessToken()` stays lazy as the
 * backstop. Neither depends on the other being right.
 *
 * This is still the one owner of refresh (AGENTS.md, Credential rules): one
 * function, one household at a time, so no two writers ever race over one
 * household's rotation. A home whose link cannot be refreshed — a pasted
 * Playground token has no refresh token — is skipped and said so; one home's
 * failure never stops the next home's refresh.
 */
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { getAccessToken, readTokens } from './ring-token.mjs';
import { expiresAt, isRefreshable } from './token-policy.mjs';
import { householdOfLinkRow, linkedHouseholdsPage, touchLinkExpiry } from './household-links.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

async function linkedHouseholds() {
  const households = [];
  let startKey;
  do {
    const page = await ddb.send(new ScanCommand(linkedHouseholdsPage({ table: TABLE, startKey })));
    for (const item of page.Items ?? []) {
      const householdId = householdOfLinkRow(item);
      if (householdId) households.push(householdId);
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return households;
}

/** One household's refresh. Never throws: the next household must still get its turn. */
export async function refreshHousehold(householdId, deps = { readTokens, getAccessToken, recordExpiry }) {
  try {
    const before = await deps.readTokens(householdId);
    if (!before) return { householdId, ok: false, reason: 'not_linked' };
    if (!isRefreshable(before)) return { householdId, ok: false, reason: 'no_refresh_token' };

    await deps.getAccessToken(householdId);
    const after = await deps.readTokens(householdId);
    await deps.recordExpiry(householdId, expiresAt(after));
    return { householdId, ok: true, minutesToExpiry: Math.round((expiresAt(after) - Date.now()) / 60000) };
  } catch (err) {
    return { householdId, ok: false, reason: err?.message ?? 'unknown' };
  }
}

/** Keep the row the family app reads in step with the secret. Best-effort: the secret is the truth. */
async function recordExpiry(householdId, at) {
  try {
    await ddb.send(new UpdateItemCommand(touchLinkExpiry({ table: TABLE, householdId, expiresAt: at })));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') console.warn(JSON.stringify({ level: 'warn', msg: 'link_expiry_not_recorded', householdId }));
  }
}

export const handler = async () => {
  const households = await linkedHouseholds();
  const results = [];
  for (const householdId of households) {
    const result = await refreshHousehold(householdId);
    // A link that cannot be refreshed needs a person; say so loudly. One that simply is not linked is a state.
    console[result.ok || result.reason === 'not_linked' || result.reason === 'no_refresh_token' ? 'log' : 'error'](
      JSON.stringify({ level: result.ok ? 'info' : 'warn', msg: result.ok ? 'refresh_ok' : 'refresh_skipped', ...result }),
    );
    results.push(result);
  }
  return { ok: results.every((r) => r.ok || r.reason === 'no_refresh_token'), households: results.length, results };
};
