/**
 * Custody of the Ring tokens, and the only place they are read or written.
 *
 * INV-1: tokens live in Secrets Manager and never leave the backend. Nothing
 * here returns a refresh token to a caller; `getAccessToken()` hands back an
 * access token and nothing else.
 *
 * Refresh is lazy and single-flight. A warm container that handles three door
 * events at once must not fire three refreshes — Ring may well rotate the
 * refresh token, and the two losers would then be holding a dead one.
 */
import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand }
  from '@aws-sdk/client-secrets-manager';
import { needsRefresh, isRefreshable, mergeTokens } from './token-policy.mjs';
import { refreshTokens, fetchAccountIdentifier, completeAppIntegration } from './ring-api.mjs';

const sm = new SecretsManagerClient({});

const SECRET_ARN = process.env.RING_SECRET_ARN;
const TOKEN_SECRET_ARN = process.env.RING_TOKEN_SECRET_ARN;

/** In-flight refresh, shared by every caller in this container. */
let inFlight = null;

export async function readCredentials() {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  return JSON.parse(r.SecretString);
}

export async function readTokens() {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: TOKEN_SECRET_ARN }));
    return r.SecretString ? JSON.parse(r.SecretString) : null;
  } catch (err) {
    // An unlinked account has a secret with no version yet. That is a state,
    // not a fault.
    if (err?.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

export async function writeTokens(record) {
  await sm.send(new PutSecretValueCommand({
    SecretId: TOKEN_SECRET_ARN,
    SecretString: JSON.stringify(record),
  }));
  return record;
}

/**
 * A valid access token, refreshing first if it is close to expiry.
 *
 * Throws `not_linked` when no one has signed in yet, and `refresh_expired`
 * when the 30-day refresh token has lapsed — two different problems with two
 * different fixes, so they are two different errors.
 */
export async function getAccessToken({ now = Date.now() } = {}) {
  const record = await readTokens();

  if (!record?.access_token && !record?.refresh_token) {
    throw new Error('not_linked');
  }

  if (!needsRefresh(record, now)) return record.access_token;

  if (!isRefreshable(record)) throw new Error('refresh_expired');

  inFlight ??= (async () => {
    try {
      const creds = await readCredentials();
      const fresh = await refreshTokens({
        refreshToken: record.refresh_token,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });

      const merged = mergeTokens(record, fresh, Date.now());
      await writeTokens(merged);

      console.log(JSON.stringify({
        level: 'info',
        msg: 'ring_token_refreshed',
        expiresIn: merged.expires_in ?? null,
        rotatedRefreshToken: Boolean(fresh.refresh_token),
      }));

      return merged.access_token;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Finish a link: store the tokens, learn the account identifier, and tell Ring
 * the integration is completed.
 *
 * The PATCH is best-effort on purpose. If it fails we still hold valid tokens,
 * and a retry is cheap — losing the tokens because the last call of four threw
 * would not be.
 */
export async function finishLink(tokens, { previous = null, now = Date.now() } = {}) {
  let record = mergeTokens(previous, tokens, now);

  let accountId = record.accountId ?? null;
  let completed = false;

  try {
    accountId ??= await fetchAccountIdentifier({ accessToken: record.access_token });
    if (accountId) record.accountId = accountId;
  } catch (err) {
    console.warn(JSON.stringify({
      level: 'warn', msg: 'account_identifier_lookup_failed',
      status: err?.status ?? null, detail: err?.detail ?? null,
    }));
  }

  try {
    await completeAppIntegration({
      accessToken: record.access_token,
      accountIdentifier: accountId,
    });
    completed = true;
    record.integrationCompletedAt = now;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'complete_integration_failed',
      status: err?.status ?? null, detail: err?.detail ?? null,
    }));
  }

  record = await writeTokens(record);

  console.log(JSON.stringify({
    level: 'info',
    msg: 'account_linked',
    expiresIn: record.expires_in ?? null,
    hasRefresh: Boolean(record.refresh_token),
    hasAccountId: Boolean(accountId),
    integrationCompleted: completed,
  }));

  return { record, completed };
}
