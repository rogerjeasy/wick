/**
 * Ring token custody for anything that runs in AWS.
 *
 * INV-1: the token lives in Secrets Manager and never leaves the backend. There
 * is no .env in a Lambda, a container or AgentCore — and there must not be, since
 * .env is gitignored and so could only arrive by being baked into an image.
 *
 * Each household has its own Ring link, and so its own secret:
 * `wick/ring/tokens/<householdId>`. There is no provider, and no client,
 * without a household — the argument is required, so a caller cannot reach
 * Ring with "the" token, only with the token of the home it is acting for
 * (AGENTS.md INV-8).
 *
 * The split is deliberate and worth stating:
 *
 *   deployed   secretsManagerTokenProvider(householdId)  — that home's secret
 *   local dev  scripts/env.ts                            — reads .env, never shipped
 *
 * Refresh is NOT done here. `wick-ring-refresh` runs hourly and owns it, so the
 * secret is already warm; duplicating that would mean two writers racing over
 * one refresh token that Ring may rotate. If this provider ever finds an expired
 * token, the refresh lambda is broken and the right response is to say so
 * loudly, not to paper over it with a second refresh path.
 */
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { RingClient, type TokenProvider } from './client.js';

/** Every household's Ring secret lives under this name. */
export const RING_TOKEN_SECRET_PREFIX = 'wick/ring/tokens';

/**
 * A household id that is safe to make part of a secret's name. Ids Wick
 * issues are `hh_<random>` or a plain name; anything with a `/` or a
 * wildcard in it could name a secret outside the household's own.
 */
const SAFE_HOUSEHOLD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The name of one household's Ring secret. */
export function ringTokenSecretId(
  householdId: string,
  prefix: string = process.env.RING_TOKEN_SECRET_PREFIX ?? RING_TOKEN_SECRET_PREFIX,
): string {
  if (!SAFE_HOUSEHOLD_ID.test(householdId)) throw new Error('unsafe_household_id');
  return `${prefix}/${householdId}`;
}

/** The record `finishLink()` and the refresh lambda write. */
export interface RingTokenRecord {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expiresAt?: number;
  readonly obtainedAt?: number;
  readonly expires_in?: number;
  readonly accountId?: string | null;
  readonly integrationCompletedAt?: number;
  readonly source?: string;
}

export class RingTokenUnavailable extends Error {
  readonly reason: 'not_linked' | 'expired';

  constructor(reason: 'not_linked' | 'expired', detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'RingTokenUnavailable';
    this.reason = reason;
  }
}

/**
 * The usable access token in a stored record, or a typed refusal.
 *
 * "Not linked" and "expired" are different problems with different fixes — one
 * needs a human to authorise, the other means the refresh schedule has stopped
 * — so they are never collapsed into one error.
 */
export function accessTokenFrom(
  record: RingTokenRecord | null,
  now: number = Date.now(),
): string {
  if (!record?.access_token) {
    throw new RingTokenUnavailable('not_linked', 'this household has no Ring link');
  }

  const expiresAt =
    record.expiresAt ??
    (record.obtainedAt != null && record.expires_in != null
      ? record.obtainedAt + record.expires_in * 1000
      : undefined);

  if (expiresAt != null && expiresAt <= now) {
    throw new RingTokenUnavailable(
      'expired',
      `token expired ${Math.round((now - expiresAt) / 1000)}s ago; ` +
        'the hourly wick-ring-refresh schedule should have renewed it',
    );
  }

  return record.access_token;
}

export interface SecretsTokenProviderOptions {
  readonly secretId?: string;
  readonly client?: Pick<SecretsManagerClient, 'send'>;
  /** How long a read is reused before going back to Secrets Manager. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

/**
 * A TokenProvider backed by Secrets Manager.
 *
 * Reads are cached briefly in-process: a door event can fan out into several
 * Ring calls, and each one paying a Secrets Manager round trip would spend the
 * five-second budget on credential lookup. The cache is dropped the moment the
 * token it holds is no longer valid.
 */
export function secretsManagerTokenProvider(
  householdId: string,
  options: SecretsTokenProviderOptions = {},
): TokenProvider {
  const secretId = options.secretId ?? ringTokenSecretId(householdId);
  const client = options.client ?? new SecretsManagerClient({});
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;

  let cached: { record: RingTokenRecord; readAt: number } | null = null;
  let inFlight: Promise<RingTokenRecord> | null = null;

  async function read(): Promise<RingTokenRecord> {
    // Single-flight. A door event fans out into several Ring calls at once, and
    // without this every one of them misses the not-yet-populated cache and
    // issues its own Secrets Manager request — the exact stampede the cache
    // exists to prevent.
    inFlight ??= (async () => {
      try {
        let result;
        try {
          result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
        } catch (err) {
          // A household that has never connected Ring has no secret at all.
          // That is a state, not a fault.
          if ((err as { name?: string }).name === 'ResourceNotFoundException') {
            throw new RingTokenUnavailable('not_linked', 'this household has no Ring link');
          }
          throw err;
        }
        if (!result.SecretString) {
          throw new RingTokenUnavailable('not_linked', `${secretId} has no value yet`);
        }
        const record = JSON.parse(result.SecretString) as RingTokenRecord;
        cached = { record, readAt: now() };
        return record;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  return async () => {
    const at = now();

    if (cached && at - cached.readAt < cacheMs) {
      try {
        return accessTokenFrom(cached.record, at);
      } catch {
        // Cached copy went stale inside its own window; fall through and re-read.
        cached = null;
      }
    }

    return accessTokenFrom(await read(), now());
  };
}

/**
 * A Ring client for a household, made once per household and kept: a warm
 * process serves many homes, and each client carries its own home's token
 * cache. This is the only way the deployed code builds a client, so there is
 * no client that is not some household's.
 */
export function ringClientsByHousehold(
  // No `secretId` here, on purpose: a name given once would be every
  // household's secret. Each household's is derived from its own id.
  options: Omit<SecretsTokenProviderOptions, 'secretId'> & { readonly fetchImpl?: typeof fetch } = {},
): (householdId: string) => RingClient {
  const clients = new Map<string, RingClient>();
  // Dropped here as well as in the type: a plain-JavaScript caller is not held by the type.
  const { fetchImpl, secretId: _oneNameForEveryone, ...providerOptions } = options as SecretsTokenProviderOptions & { readonly fetchImpl?: typeof fetch };
  return (householdId) => {
    let client = clients.get(householdId);
    if (!client) {
      client = new RingClient({
        getToken: secretsManagerTokenProvider(householdId, providerOptions),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      clients.set(householdId, client);
    }
    return client;
  };
}
