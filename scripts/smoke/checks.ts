/**
 * What the live smoke test decides, apart from how it asks: each function
 * takes an answer already fetched and says pass, fail or skip, in one line.
 * Tested with no network (scripts/__tests__/smoke-checks.test.ts); the asking
 * is scripts/smoke/run.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Outcome = 'pass' | 'fail' | 'skip' | 'info';

export interface CheckResult {
  readonly name: string;
  readonly outcome: Outcome;
  /** What was measured, in words a person reads in a terminal. */
  readonly detail: string;
}

export const pass = (name: string, detail: string): CheckResult => ({ name, outcome: 'pass', detail });
export const fail = (name: string, detail: string): CheckResult => ({ name, outcome: 'fail', detail });
export const skip = (name: string, detail: string): CheckResult => ({ name, outcome: 'skip', detail });
export const info = (name: string, detail: string): CheckResult => ({ name, outcome: 'info', detail });

/** The deployment the owner runs. Each can be pointed elsewhere for a stack of your own. */
export const LIVE = {
  familyApp: 'https://dmaz25jvryojp.cloudfront.net',
  virtualTv: 'https://d2sbabcft8sm3m.cloudfront.net',
  server: 'https://tqcu7pa3ip.us-east-1.awsapprunner.com',
  status: 'https://aplt2e6673.execute-api.us-east-1.amazonaws.com/status',
} as const;

// ---------------------------------------------------------------------------
// Features that arrive with open pull requests. A check of one starts the day
// the checkout holds the file that pull request adds: the smoke workflow runs
// on main after the deploys have finished, so the checkout is what is
// deployed. Until then the check still runs if the live stack already shows
// the feature, and says "not deployed yet" when it does not.
// ---------------------------------------------------------------------------

export interface Features {
  /** #70: CSP, HSTS, nosniff and frame denial on both CloudFront sites. */
  readonly securityHeaders: boolean;
  /** #70: GET /api/account/export, GET /account/sign-out, DELETE /api/account. */
  readonly accountData: boolean;
  /** #68: the circle names a television by a `ref`, never by its device id. */
  readonly televisionRef: boolean;
}

export const FEATURE_MARKERS: Record<keyof Features, string> = {
  securityHeaders: 'infra/csp/family-app.csp',
  accountData: 'services/mcp-server/src/accounts/accountDataRouter.ts',
  televisionRef: 'services/edge-device/lambda/proof.mjs',
};

export const FEATURE_PRS: Record<keyof Features, string> = {
  securityHeaders: '#70',
  accountData: '#70',
  televisionRef: '#68',
};

export function featuresIn(root: string, exists: (path: string) => boolean = existsSync): Features {
  return {
    securityHeaders: exists(join(root, FEATURE_MARKERS.securityHeaders)),
    accountData: exists(join(root, FEATURE_MARKERS.accountData)),
    televisionRef: exists(join(root, FEATURE_MARKERS.televisionRef)),
  };
}

/** How many MCP tools the checkout registers: one `registerTool(` per tool file. */
export function countRegisteredTools(sources: readonly string[]): number {
  return sources.reduce((sum, source) => sum + (source.match(/\.registerTool\(/g)?.length ?? 0), 0);
}

export function toolSources(root: string): string[] {
  const dir = join(root, 'services/mcp-server/src/tools');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'));
}

export function toolCountVerdict(listed: number, expected: number): CheckResult {
  const name = 'tools/list';
  return listed === expected
    ? pass(name, `${listed} tools, as the checkout registers`)
    : fail(name, `${listed} tools listed; the checkout registers ${expected}`);
}

// ---------------------------------------------------------------------------
// The two CloudFront sites
// ---------------------------------------------------------------------------

/** What is missing of the four headers #70 puts on both sites. */
export function missingSecurityHeaders(headers: Headers): string[] {
  const missing: string[] = [];
  const csp = headers.get('content-security-policy') ?? '';
  if (!csp) missing.push('Content-Security-Policy');
  const maxAge = /max-age=(\d+)/i.exec(headers.get('strict-transport-security') ?? '')?.[1];
  if (!maxAge || Number(maxAge) <= 0) missing.push('Strict-Transport-Security');
  if ((headers.get('x-content-type-options') ?? '').toLowerCase() !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
  const framing = (headers.get('x-frame-options') ?? '').toUpperCase();
  if (framing !== 'DENY' && !/frame-ancestors\s+'none'/i.test(csp)) missing.push("frame denial (X-Frame-Options: DENY or frame-ancestors 'none')");
  return missing;
}

export function siteVerdict(site: string, status: number, headers: Headers, expectHeaders: boolean): CheckResult[] {
  const results = [status === 200 ? pass(site, '200') : fail(site, `answered ${status}; 200 is required`)];
  const name = `${site} security headers`;
  const missing = missingSecurityHeaders(headers);
  if (missing.length === 0) results.push(pass(name, 'CSP, HSTS, nosniff and frame denial'));
  else if (!expectHeaders && missing.length === 4) results.push(skip(name, `none sent: not deployed yet (${FEATURE_PRS.securityHeaders})`));
  else results.push(fail(name, `missing ${missing.join(', ')}`));
  return results;
}

// ---------------------------------------------------------------------------
// The ops console's status API
// ---------------------------------------------------------------------------

/**
 * Warnings the status page gives on a healthy stack, by design, and why each
 * is accepted. Any other warning fails the smoke test, as does any failure.
 *
 * Not accepted, on purpose: `ringOperatorLink` warns when the operator's
 * unauthenticated link to Ring was left on, and `doorDeadLetters` warns when
 * the dead-letter queue could not be read. Both want a person.
 */
export const ACCEPTED_STATUS_WARNINGS: Readonly<Record<string, string>> = {
  ringLink:
    "the operator household's Ring link is a Playground token, which runs out after about 30 minutes and cannot be refreshed (FRICTION.md FL-010); demo homes do not use it",
};

interface StatusRow {
  readonly id?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
}

export function statusVerdict(body: unknown): CheckResult {
  const name = 'status API';
  const summary = (body as { summary?: { healthy?: unknown } } | null)?.summary;
  const rows = (body as { checks?: unknown } | null)?.checks;
  if (!summary || !Array.isArray(rows)) return fail(name, 'answered without a summary and checks');
  const checks = rows as StatusRow[];
  const failing = checks.filter((c) => c.status === 'fail').map((c) => `${String(c.id)} (${String(c.detail)})`);
  if (failing.length > 0 || summary.healthy !== true) return fail(name, `not healthy: ${failing.join('; ') || 'summary says so'}`);
  const warnings = checks.filter((c) => c.status === 'warn').map((c) => String(c.id));
  const unknown = warnings.filter((id) => !(id in ACCEPTED_STATUS_WARNINGS));
  if (unknown.length > 0) {
    const said = checks.filter((c) => unknown.includes(String(c.id))).map((c) => `${String(c.id)} (${String(c.detail)})`);
    return fail(name, `a warning that is not a known one: ${said.join('; ')}`);
  }
  const ok = checks.filter((c) => c.status === 'ok').length;
  return pass(name, `healthy, ${ok} ok${warnings.length ? `; known warnings: ${warnings.join(', ')}` : ''}`);
}

// ---------------------------------------------------------------------------
// OAuth metadata
// ---------------------------------------------------------------------------

export function protectedResourceVerdict(status: number, body: unknown): CheckResult {
  const name = 'protected resource metadata';
  if (status !== 200) return fail(name, `answered ${status}; 200 is required`);
  const meta = (body ?? {}) as { resource?: unknown; authorization_servers?: unknown };
  if (typeof meta.resource !== 'string') return fail(name, 'has no resource');
  if (!Array.isArray(meta.authorization_servers) || meta.authorization_servers.length === 0) return fail(name, 'names no authorization server');
  return pass(name, `200, resource ${meta.resource}`);
}

// ---------------------------------------------------------------------------
// The guest's own data (#70, #68)
// ---------------------------------------------------------------------------

/** Keys a person's export must never hold: a credential, a code or a hash of one. */
const SECRET_KEY = /(secret|password|passcode|^code$|code_?hash|code_?verifier|invite_?code|access_?token|refresh_?token|id_?token|^jwt$|token_?hash|proof)/i;
/** A JSON Web Token, or a long run of base64url with nothing else in it: what a token or a code looks like. */
const OPAQUE = /^(eyJ[\w-]+\.[\w-]+\.[\w-]*|[A-Za-z0-9_-]{32,})$/;

/**
 * Where in an export something that could be a credential sits. `token` is
 * the one key allowed, and only to say which kind of token a linked app holds
 * (`access` or `refresh`), never the token.
 */
export function secretsInExport(value: unknown, known: readonly string[] = [], path = '$'): string[] {
  if (typeof value === 'string') {
    if (known.some((secret) => secret && value.includes(secret))) return [`${path} holds one of the guest's own tokens`];
    return OPAQUE.test(value) ? [`${path} looks like a token or a code`] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => secretsInExport(item, known, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => {
      const at = `${path}.${key}`;
      if (key === 'token') return inner === 'access' || inner === 'refresh' ? [] : [`${at} is not just the kind of token`];
      if (SECRET_KEY.test(key)) return [`${at} is a credential's field`];
      return secretsInExport(inner, known, at);
    });
  }
  return [];
}

export function exportVerdict(status: number, text: string, known: readonly string[], expected: boolean): CheckResult {
  const name = 'GET /api/account/export';
  if (status === 404 && !expected) return skip(name, `404: not deployed yet (${FEATURE_PRS.accountData})`);
  if (status !== 200) return fail(name, `answered ${status}; 200 is required`);
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    return fail(name, 'answered 200 with something that is not JSON');
  }
  const found = secretsInExport(file, known);
  return found.length === 0 ? pass(name, 'JSON, with no token, secret or code in it') : fail(name, found.slice(0, 5).join('; '));
}

/** Every place in the circle a device id could be told: a `deviceId` key anywhere, or a television with no `ref`. */
export function circleVerdict(status: number, body: unknown, expected: boolean): CheckResult {
  const name = 'televisions named by ref';
  if (!expected) return skip(name, `not deployed yet (${FEATURE_PRS.televisionRef})`);
  if (status !== 200) return fail(name, `GET /api/circle answered ${status}`);
  const told = JSON.stringify(body ?? null).match(/"deviceId"\s*:/g)?.length ?? 0;
  if (told > 0) return fail(name, `GET /api/circle holds ${told} device id${told === 1 ? '' : 's'}`);
  const circle = (body ?? {}) as { televisions?: unknown; familyTelevisions?: unknown };
  const sets = [circle.televisions, circle.familyTelevisions].map((list) => (Array.isArray(list) ? (list as Record<string, unknown>[]) : []));
  const all = sets.flat();
  const unnamed = all.filter((tv) => typeof tv?.ref !== 'string').length;
  if (unnamed > 0) return fail(name, `${unnamed} television${unnamed === 1 ? '' : 's'} with no ref`);
  return pass(name, all.length === 0 ? 'no device id in GET /api/circle (a new demo home has no television to name)' : `${all.length} television(s), each by ref`);
}
