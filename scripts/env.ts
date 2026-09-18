/**
 * Local-development environment loading, in one place.
 *
 * Both demo scripts used to hand-parse a single line out of .env for the Ring
 * token and leave everything else alone — which is how a .env holding AWS
 * credentials produced "Could not load credentials from any providers". The
 * keys were there; nothing read them, and they were under names the AWS SDK
 * does not recognise.
 *
 * Nothing here ever prints a value. Every report names a source.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secretsManagerTokenProvider } from '@wick/ring';

export type EnvMap = Record<string, string>;

/** Parse a .env. Ignores blanks and #comments; strips one layer of quotes. */
export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    out[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * The AWS SDK reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY. A .env
 * written by hand very often says AWS_ACCESS_KEY and AWS_SECRET_KEY, which are
 * not the same names and are silently ignored.
 */
const KEY_ALIASES: ReadonlyArray<readonly [canonical: string, ...aliases: string[]]> = [
  ['AWS_ACCESS_KEY_ID', 'AWS_ACCESS_KEY', 'AWS_ACCESS_KEY_ID'],
  ['AWS_SECRET_ACCESS_KEY', 'AWS_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY'],
  ['AWS_SESSION_TOKEN', 'AWS_SESSION_TOKEN'],
];

export interface AwsResolution {
  /** Where the credentials came from — for reporting, never the values. */
  readonly source: 'shell' | 'env-file-keys' | 'shell-profile' | 'default-profile' | 'none';
  /** Variables to apply to process.env. Never logged. */
  readonly vars: EnvMap;
  readonly detail: string;
}

/**
 * Decide how this process should authenticate to AWS.
 *
 * Order is least-surprising first: whatever the shell already set wins, since
 * someone who exported a profile meant it. Only then does .env contribute.
 */
export function resolveAws(
  fileEnv: EnvMap,
  processEnv: EnvMap,
  availableProfiles: readonly string[] = [],
  preferredProfile = 'wick-dev',
): AwsResolution {
  const region =
    processEnv.AWS_REGION ?? processEnv.AWS_DEFAULT_REGION ?? fileEnv.AWS_REGION ?? 'us-east-1';
  const base: EnvMap = { AWS_REGION: region, AWS_DEFAULT_REGION: region };

  if (processEnv.AWS_ACCESS_KEY_ID || processEnv.AWS_PROFILE) {
    return {
      source: 'shell',
      vars: base,
      detail: processEnv.AWS_PROFILE ? `profile ${processEnv.AWS_PROFILE}` : 'access key in shell',
    };
  }

  const fromFile: EnvMap = {};
  for (const [canonical, ...aliases] of KEY_ALIASES) {
    for (const alias of aliases) {
      const value = fileEnv[alias];
      if (value) { fromFile[canonical] = value; break; }
    }
  }

  if (fromFile.AWS_ACCESS_KEY_ID && fromFile.AWS_SECRET_ACCESS_KEY) {
    return {
      source: 'env-file-keys',
      vars: { ...base, ...fromFile },
      detail: '.env access key (mapped to the names the AWS SDK reads)',
    };
  }

  if (fileEnv.AWS_PROFILE) {
    return { source: 'shell-profile', vars: { ...base, AWS_PROFILE: fileEnv.AWS_PROFILE },
             detail: `profile ${fileEnv.AWS_PROFILE} from .env` };
  }

  if (availableProfiles.includes(preferredProfile)) {
    return { source: 'default-profile', vars: { ...base, AWS_PROFILE: preferredProfile },
             detail: `profile ${preferredProfile} from ~/.aws` };
  }

  return { source: 'none', vars: base, detail: 'no AWS credentials found' };
}

/** Profile names declared in ~/.aws/config and ~/.aws/credentials. */
export function readAwsProfiles(home = homedir()): string[] {
  const names = new Set<string>();
  for (const file of ['config', 'credentials']) {
    const path = join(home, '.aws', file);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(/^\[(?:profile\s+)?([^\]]+)\]/gm)) {
      names.add(m[1]!.trim());
    }
  }
  return [...names];
}

let cached: EnvMap | null = null;

function envFile(): EnvMap {
  if (cached) return cached;
  const path = new URL('../.env', import.meta.url);
  cached = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  return cached;
}

/**
 * Apply .env to this process and report what AWS will authenticate with.
 * Call once, at the top of a script, before anything constructs an AWS client.
 */
export function loadEnv(): AwsResolution {
  const file = envFile();
  const resolution = resolveAws(file, process.env as EnvMap, readAwsProfiles());

  for (const [k, v] of Object.entries(resolution.vars)) process.env[k] = v;

  return resolution;
}

export type RingTokenSource =
  | { readonly kind: 'secrets-manager' }
  | { readonly kind: 'env-file' }
  | { readonly kind: 'none' };

/**
 * Which credential a local script should use, and why.
 *
 * `.env`'s `RING_OAUTH_TOKEN` (a Ring Developer Playground token, ~30 min,
 * no refresh) wins whenever it's present. That is deliberately the opposite
 * of "prefer the permanent one": the real, auto-refreshing account in
 * Secrets Manager (`wick-ring-refresh` keeps it warm hourly) currently has
 * zero connected Ring locations, so `listDevices()` against it returns
 * nothing to demo against. The Playground identity is the only one with an
 * actual device — see FRICTION.md FL-010. Secrets Manager is the fallback,
 * useful for calls that don't need a device to exist (or once the real
 * account has one).
 */
export function chooseRingTokenSource(
  secretsManagerUsable: boolean,
  envFileTokenPresent: boolean,
): RingTokenSource {
  if (envFileTokenPresent) return { kind: 'env-file' };
  if (secretsManagerUsable) return { kind: 'secrets-manager' };
  return { kind: 'none' };
}

let cachedSecretsManagerToken: ReturnType<typeof secretsManagerTokenProvider> | undefined;

export async function ringToken(): Promise<string> {
  const fromFile = process.env.RING_OAUTH_TOKEN ?? envFile().RING_OAUTH_TOKEN;

  // Only reach for Secrets Manager when .env has nothing — no need to pay an
  // AWS round trip, or require AWS credentials at all, when a Playground
  // token already answers the question.
  let fromSecretsManager: string | undefined;
  if (!fromFile) {
    cachedSecretsManagerToken ??= secretsManagerTokenProvider();
    try {
      fromSecretsManager = await cachedSecretsManagerToken();
    } catch {
      // Not linked, expired with no refresh path, or no AWS credentials in
      // this shell — any of those means "fall back," not "fail here."
      fromSecretsManager = undefined;
    }
  }

  const source = chooseRingTokenSource(fromSecretsManager !== undefined, Boolean(fromFile));

  if (source.kind === 'env-file') return fromFile!;
  if (source.kind === 'secrets-manager') return fromSecretsManager!;

  throw new Error(
    'No usable Ring token. Either link the real account once (the ring_authorize_url ' +
      "Terraform output) and let the hourly wick-ring-refresh job keep it warm forever, " +
      'or — for a quick one-off — generate a Playground token at ' +
      'https://developer.amazon.com/ring/console/playground and put it in .env as ' +
      'RING_OAUTH_TOKEN (lasts 30 minutes).',
  );
}
