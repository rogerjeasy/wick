/**
 * Custody of the Ring tokens, and the only place they are read or written.
 *
 * INV-1: tokens live in Secrets Manager and never leave the backend. Nothing
 * here returns a refresh token to a caller; `getAccessToken()` hands back an
 * access token and nothing else.
 *
 * One secret per household — `<prefix>/<householdId>` — and every function
 * here takes the household first. There is no "the" Ring token: a link is a
 * home's own, made by its organiser (household-link.mjs), and it is read
 * only for that home (AGENTS.md INV-8).
 *
 * Refresh is lazy and single-flight per household. A warm container that
 * handles three door events at once must not fire three refreshes — Ring may
 * well rotate the refresh token, and the two losers would then be holding a
 * dead one.
 */
import {
  SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand, CreateSecretCommand, DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { needsRefresh, isRefreshable, linkTokens, mergeTokens } from './token-policy.mjs';
import { refreshTokens, fetchAccountIdentifier, completeAppIntegration } from './ring-api.mjs';

const sm = new SecretsManagerClient({});

const SECRET_ARN = process.env.RING_SECRET_ARN;
const TOKEN_SECRET_PREFIX = process.env.RING_TOKEN_SECRET_PREFIX ?? 'wick/ring/tokens';

/**
 * A household id that is safe to make part of a secret's name: no `/`, no
 * wildcard, nothing that could name a secret outside the household's own.
 * (The same rule as services/connectors/ring/src/secrets.ts.)
 */
export const SAFE_HOUSEHOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The name of one household's Ring secret. */
export function tokenSecretId(householdId, prefix = TOKEN_SECRET_PREFIX) {
  if (typeof householdId !== 'string' || !SAFE_HOUSEHOLD_ID.test(householdId)) throw new Error('unsafe_household_id');
  return `${prefix}/${householdId}`;
}

/** In-flight refreshes, one per household, shared by every caller in this container. */
const inFlight = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function readCredentials() {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  return JSON.parse(r.SecretString);
}

export async function readTokens(householdId) {
  try {
    const r = await sm.send(new GetSecretValueCommand({ SecretId: tokenSecretId(householdId) }));
    return r.SecretString ? JSON.parse(r.SecretString) : null;
  } catch (err) {
    // A household that has never connected Ring has no secret. That is a
    // state, not a fault.
    if (err?.name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

/**
 * Write a household's record. Only a link may bring a secret into being
 * (`create: true` — finishLink, and a pasted Playground token). A refresh
 * never may: if the organiser disconnected while a refresh was in flight,
 * the secret is gone, and a refresh that re-created it would quietly undo
 * the disconnect. That write fails with `not_linked` instead.
 */
export async function writeTokens(householdId, record, { create = false } = {}) {
  const SecretId = tokenSecretId(householdId);
  const SecretString = JSON.stringify(record);
  try {
    await sm.send(new PutSecretValueCommand({ SecretId, SecretString }));
    return record;
  } catch (err) {
    if (err?.name !== 'ResourceNotFoundException') throw err;
  }
  if (!create) throw new Error('not_linked');
  // The household's first link: its secret does not exist yet. A secret
  // deleted moments ago (a disconnect, then a reconnect) keeps its name
  // reserved for a few seconds, so that case is waited out.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sm.send(new CreateSecretCommand({
        Name: SecretId,
        SecretString,
        Description: `Ring tokens for household ${householdId}. Written by the Ring linking functions only.`,
      }));
      return record;
    } catch (err) {
      if (err?.name === 'ResourceExistsException') {
        await sm.send(new PutSecretValueCommand({ SecretId, SecretString }));
        return record;
      }
      if (err?.name !== 'InvalidRequestException' || attempt >= 4) throw err;
      await sleep(1500);
    }
  }
}

/** A disconnect. The secret goes at once, with no recovery window: nothing should be able to bring a removed link back. */
export async function deleteTokens(householdId) {
  try {
    await sm.send(new DeleteSecretCommand({ SecretId: tokenSecretId(householdId), ForceDeleteWithoutRecovery: true }));
  } catch (err) {
    if (err?.name !== 'ResourceNotFoundException') throw err;
  }
}

/**
 * A valid access token, refreshing first if it is close to expiry.
 *
 * Throws `not_linked` when no one has signed in yet, and `refresh_expired`
 * when the 30-day refresh token has lapsed — two different problems with two
 * different fixes, so they are two different errors.
 */
export async function getAccessToken(householdId, { now = Date.now() } = {}) {
  const record = await readTokens(householdId);

  if (!record?.access_token && !record?.refresh_token) {
    throw new Error('not_linked');
  }

  if (!needsRefresh(record, now)) return record.access_token;

  if (!isRefreshable(record)) throw new Error('refresh_expired');

  if (inFlight.has(householdId)) return inFlight.get(householdId);

  const refreshing = (async () => {
    try {
      const creds = await readCredentials();
      const fresh = await refreshTokens({
        refreshToken: record.refresh_token,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
      });

      const merged = mergeTokens(record, fresh, Date.now());
      await writeTokens(householdId, merged);

      console.log(JSON.stringify({
        level: 'info',
        msg: 'ring_token_refreshed',
        expiresIn: merged.expires_in ?? null,
        rotatedRefreshToken: Boolean(fresh.refresh_token),
      }));

      return merged.access_token;
    } finally {
      inFlight.delete(householdId);
    }
  })();

  inFlight.set(householdId, refreshing);
  return refreshing;
}

/**
 * Finish a link: store the tokens, learn the account identifier, and tell Ring
 * the integration is completed.
 *
 * The PATCH is best-effort on purpose. If it fails we still hold valid tokens,
 * and a retry is cheap — losing the tokens because the last call of four threw
 * would not be.
 */
export async function finishLink(householdId, tokens, { previous = null, now = Date.now() } = {}) {
  let record = linkTokens(previous, tokens, now);

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

  record = await writeTokens(householdId, record, { create: true });

  console.log(JSON.stringify({
    level: 'info',
    msg: 'account_linked',
    householdId,
    expiresIn: record.expires_in ?? null,
    hasRefresh: Boolean(record.refresh_token),
    hasAccountId: Boolean(accountId),
    integrationCompleted: completed,
  }));

  return { record, completed };
}
