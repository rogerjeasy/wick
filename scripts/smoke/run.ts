/**
 * The live smoke test's questions, in order, against the deployed stack:
 * the two sites, the status page, the Wick server's sign-in metadata and
 * its refusal of a stranger, then a fresh demo guest's conversation, data,
 * sign-out and deletion.
 *
 * The guest is the one thing it makes: one guest and one demo home, as one
 * click on the family app's "Try the demo" makes (at most 60 an hour, per
 * server). Once account deletion is deployed (#70) the guest deletes itself
 * at the end, whatever happened before; until then it is left, as every
 * visitor's guest is. The demo home's simulated history expires after 60
 * days (the table's TTL); the guest's account and home rows do not.
 *
 * It never prints a token.
 */
import { checkAuthMetadata, checkUnauthenticated, median, rpc, SPEC_VERSION, type Fetch } from '../addon/preflight.js';
import { demoSession, type DemoSession } from '../addon/demo-token.js';
import {
  circleVerdict,
  exportVerdict,
  fail,
  FEATURE_PRS,
  info,
  pass,
  protectedResourceVerdict,
  siteVerdict,
  skip,
  statusVerdict,
  toolCountVerdict,
  type CheckResult,
  type Features,
} from './checks.js';

export interface SmokeConfig {
  readonly familyApp: string;
  readonly virtualTv: string;
  readonly server: string;
  readonly status: string;
  readonly features: Features;
  readonly expectedTools: number;
}

const LATENCY_SAMPLES = 5;
const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs every check, handing each result to `say` as it comes. Returns how many failed. */
export async function runSmoke(config: SmokeConfig, fetch: Fetch, say: (result: CheckResult) => void, now: () => number = Date.now): Promise<number> {
  let failures = 0;
  const tell = (result: CheckResult): void => {
    if (result.outcome === 'fail') failures += 1;
    say(result);
  };
  /** One check that may throw: a throw is that check's failure, and the run goes on. */
  const attempt = async (name: string, check: () => Promise<CheckResult | CheckResult[]>): Promise<void> => {
    try {
      const out = await check();
      for (const result of Array.isArray(out) ? out : [out]) tell(result);
    } catch (err) {
      tell(fail(name, why(err)));
    }
  };

  for (const [site, url] of [['family app', config.familyApp], ['virtual television', config.virtualTv]] as const) {
    await attempt(site, async () => {
      const res = await fetch(`${url}/`);
      return siteVerdict(`${site} ${url}`, res.status, res.headers, config.features.securityHeaders);
    });
  }

  await attempt('status API', async () => {
    const res = await fetch(config.status);
    return res.status === 200 ? statusVerdict(await res.json()) : fail('status API', `answered ${res.status}`);
  });

  const endpoint = `${config.server}/mcp`;
  await attempt('protected resource metadata', async () => {
    const res = await fetch(`${config.server}/.well-known/oauth-protected-resource`);
    return protectedResourceVerdict(res.status, res.status === 200 ? await res.json() : undefined);
  });
  tell(await checkAuthMetadata(endpoint, fetch));
  tell(await checkUnauthenticated(endpoint, fetch));

  let session: DemoSession;
  try {
    session = await demoSession(config.server, fetch, 'the Wick live smoke test');
    tell(pass('demo guest', 'signed in as a fresh guest'));
  } catch (err) {
    tell(fail('demo guest', why(err)));
    return failures;
  }

  /** The token the guest can still use: the first, then the one a refresh gives after it is revoked. */
  let token = session.accessToken;
  const known = [session.accessToken, session.refreshToken ?? ''];
  const api = (path: string, init: RequestInit = {}, bearer = token) =>
    fetch(`${config.server}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${bearer}` } });

  try {
    await attempt('MCP conversation', async () => {
      const results: CheckResult[] = [];
      let id = 0;
      const ask = (method: string, params: object, bearer = token) => rpc(endpoint, bearer, { jsonrpc: '2.0', id: (id += 1), method, params }, fetch);
      const result = (body: Record<string, unknown> | undefined) => body?.result as Record<string, unknown> | undefined;

      const hello = result((await ask('initialize', { protocolVersion: SPEC_VERSION, capabilities: {}, clientInfo: { name: 'wick-smoke', version: '1.0.0' } })).body);
      results.push(
        hello?.protocolVersion === SPEC_VERSION
          ? pass('initialize', `protocol ${SPEC_VERSION}`)
          : fail('initialize', hello ? `answered protocol ${String(hello.protocolVersion)}; ${SPEC_VERSION} was asked for` : 'no result'),
      );

      const tools = ((result((await ask('tools/list', {})).body)?.tools ?? []) as { name?: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: { required?: string[] } }[]).filter(
        (t) => typeof t?.name === 'string',
      );
      results.push(toolCountVerdict(tools.length, config.expectedTools));

      const reader = tools.find((t) => t.annotations?.readOnlyHint === true && (t.inputSchema?.required ?? []).length === 0);
      if (!reader) {
        results.push(fail('read tool', 'no read-only tool that needs no arguments'));
      } else {
        const called = result((await ask('tools/call', { name: reader.name, arguments: {} })).body);
        const text = (called?.content as { text?: string }[] | undefined)?.[0]?.text ?? '';
        results.push(
          called && !called.isError && text
            ? pass(`tools/call ${String(reader.name)}`, `answered: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`)
            : fail(`tools/call ${String(reader.name)}`, called?.isError ? `answered an error: "${text.slice(0, 80)}"` : 'no answer'),
        );
      }

      const samples: number[] = [];
      for (let i = 0; i < LATENCY_SAMPLES; i += 1) {
        const started = now();
        await ask('tools/list', {});
        samples.push(now() - started);
      }
      results.push(info('MCP round trip', `median ${Math.round(median(samples))} ms over ${LATENCY_SAMPLES} tools/list calls, from this machine (reported, never failed: issue #47)`));
      return results;
    });

    await attempt('televisions named by ref', async () => {
      if (!config.features.televisionRef) return circleVerdict(0, undefined, false);
      const res = await api('/api/circle');
      return circleVerdict(res.status, res.status === 200 ? await res.json() : undefined, true);
    });

    await attempt('GET /api/account/export', async () => {
      const res = await api('/api/account/export');
      return exportVerdict(res.status, await res.text(), known, config.features.accountData);
    });

    await attempt('GET /account/sign-out', async () => {
      const name = 'GET /account/sign-out';
      const signOut = (redirect: string) =>
        fetch(`${config.server}/account/sign-out?${new URLSearchParams({ client_id: session.clientId, redirect_uri: redirect })}`, { redirect: 'manual' });
      const home = await signOut(session.redirectUri);
      if (home.status === 404 && !config.features.accountData) return skip(name, `404: not deployed yet (${FEATURE_PRS.accountData})`);
      if (home.status < 300 || home.status > 399 || home.headers.get('location') !== session.redirectUri) {
        return fail(name, `answered ${home.status} to the client's own address; a redirect back to it is required`);
      }
      const elsewhere = await signOut('https://example.invalid/');
      if (elsewhere.status >= 300 && elsewhere.status <= 399) return fail(name, `redirected to an address the client never registered (${elsewhere.headers.get('location')})`);
      return pass(name, `${home.status} back to the client's own address, and nowhere else`);
    });

    await attempt('sign-out revokes', async () => {
      const name = 'sign-out revokes';
      if (!session.revocationEndpoint) return fail(name, 'the server names no revocation_endpoint');
      const revoked = await fetch(session.revocationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: session.accessToken, token_type_hint: 'access_token', client_id: session.clientId }),
      });
      if (revoked.status !== 200) return fail(name, `/revoke answered ${revoked.status}`);
      const after = await rpc(endpoint, session.accessToken, { jsonrpc: '2.0', id: 900, method: 'tools/list' }, fetch);
      if (after.status !== 401) return fail(name, `the revoked token was answered ${after.status}; 401 is required`);
      if (!session.refreshToken) return pass(name, 'the revoked access token is refused (401)');
      const refreshed = await fetch(session.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: session.clientId }),
      });
      if (!refreshed.ok) return fail(name, `the revoked token is refused (401), but the refresh token then answered ${refreshed.status}`);
      token = ((await refreshed.json()) as { access_token: string }).access_token;
      known.push(token);
      return pass(name, 'the revoked access token is refused (401); the refresh token still gives a new one');
    });
  } finally {
    await attempt('DELETE /api/account', async () => {
      const name = 'DELETE /api/account';
      const res = await api('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ closeHomes: true }) });
      if (res.status === 404 && !config.features.accountData) {
        return skip(name, `404: not deployed yet (${FEATURE_PRS.accountData}); the guest is left, as a visitor's is`);
      }
      if (res.status !== 200) return fail(name, `answered ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const after = await api('/api/me');
      return after.status === 401
        ? pass(name, 'the guest and its demo home are deleted, and its token is refused (401)')
        : fail(name, `deleted, but its token was then answered ${after.status}; 401 is required`);
    });
  }
  return failures;
}
