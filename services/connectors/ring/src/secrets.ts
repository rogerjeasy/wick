/**
 * Ring token custody for anything that runs in AWS.
 *
 * INV-1: the token lives in Secrets Manager and never leaves the backend. There
 * is no .env in a Lambda, a container or AgentCore — and there must not be, since
 * .env is gitignored and so could only arrive by being baked into an image.
 *
 * The split is deliberate and worth stating:
 *
 *   deployed   secretsManagerTokenProvider()  — reads wick/ring/tokens
 *   local dev  scripts/env.ts                 — reads .env, never shipped
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
import type { TokenProvider } from './client.js';

export const RING_TOKEN_SECRET_ID = 'wick/ring/tokens';

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
    throw new RingTokenUnavailable('not_linked', `no access token in ${RING_TOKEN_SECRET_ID}`);
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
  options: SecretsTokenProviderOptions = {},
): TokenProvider {
  const secretId = options.secretId ?? process.env.RING_TOKEN_SECRET_ID ?? RING_TOKEN_SECRET_ID;
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
        const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
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
