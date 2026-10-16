import { describe, expect, it } from 'vitest';
import { runSmoke } from '../smoke/run.js';
import type { CheckResult, Features } from '../smoke/checks.js';
import type { Fetch } from '../addon/preflight.js';

const SERVER = 'https://mcp.wick.test';
const HEADERS = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * A stack that answers the way the live one does: with or without #70
 * (security headers, sign-out, export, deletion). Tokens are revocable and
 * refreshable, as on main today.
 */
function stack(withPr70: boolean) {
  const live = new Set<string>();
  const asked: string[] = [];
  let issued = 0;
  const mint = () => {
    issued += 1;
    const token = `token-${issued}`;
    live.add(token);
    return token;
  };
  const bearer = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace('Bearer ', '');

  const fetch: Fetch = async (url, init) => {
    const { origin, pathname, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    asked.push(`${method} ${pathname}`);
    if (origin !== SERVER) {
      if (pathname === '/status') return Response.json({ checks: [{ id: 'mcpServer', status: 'ok' }], summary: { healthy: true } });
      return new Response('<html>', { headers: withPr70 ? HEADERS : {} });
    }
    switch (`${method} ${pathname}`) {
      case 'GET /.well-known/oauth-protected-resource':
        return Response.json({ resource: `${SERVER}/`, authorization_servers: [`${SERVER}/`] });
      case 'GET /.well-known/oauth-authorization-server':
        return Response.json({
          authorization_endpoint: `${SERVER}/authorize`,
          token_endpoint: `${SERVER}/token`,
          registration_endpoint: `${SERVER}/register`,
          revocation_endpoint: `${SERVER}/revoke`,
          code_challenge_methods_supported: ['S256'],
        });
      case 'POST /register':
        return Response.json({ client_id: 'client-1' }, { status: 201 });
      case 'GET /authorize':
        return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:9/addon-check?code=code-1` } });
      case 'POST /token': {
        const form = new URLSearchParams(String(init?.body));
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== 'refresh-1') return new Response('', { status: 400 });
        return Response.json({ access_token: mint(), refresh_token: 'refresh-1' });
      }
      case 'POST /revoke':
        live.delete(new URLSearchParams(String(init?.body)).get('token') ?? '');
        return new Response(null, { status: 200 });
      case 'POST /mcp': {
        if (!live.has(bearer(init))) return new Response('', { status: 401 });
        const message = JSON.parse(String(init?.body)) as { id: number; method: string; params: { protocolVersion?: string } };
        const result =
          message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'get_today', annotations: { readOnlyHint: true }, inputSchema: {} }, { name: 'add_regular_visitor', annotations: {} }] }
              : { content: [{ type: 'text', text: 'Margaret hasn’t allowed this yet.' }] };
        return Response.json({ jsonrpc: '2.0', id: message.id, result });
      }
      case 'GET /api/me':
        return live.has(bearer(init)) ? Response.json({ user: {} }) : new Response('', { status: 401 });
    }
    if (!withPr70) return new Response('Cannot', { status: 404 });
    switch (`${method} ${pathname}`) {
      case 'GET /api/account/export':
        return Response.json({ account: { name: 'Sarah' }, linkedApps: [{ app: 'smoke', token: 'access' }] });
      case 'GET /account/sign-out': {
        const back = searchParams.get('redirect_uri');
        return back === 'http://127.0.0.1:9/addon-check' ? new Response(null, { status: 303, headers: { location: back } }) : new Response('<html>');
      }
      case 'DELETE /api/account':
        if (!live.has(bearer(init))) return new Response('', { status: 401 });
        live.clear();
        return Response.json({ deleted: true });
    }
    return new Response('Cannot', { status: 404 });
  };
  return { fetch, asked };
}

async function run(withPr70: boolean, features: Partial<Features> = {}) {
  const results: CheckResult[] = [];
  const { fetch, asked } = stack(withPr70);
  const failures = await runSmoke(
    {
      familyApp: 'https://app.wick.test',
      virtualTv: 'https://tv.wick.test',
      server: SERVER,
      status: 'https://edge.wick.test/status',
      features: { securityHeaders: false, accountData: false, televisionRef: false, browserTelevision: false, ...features },
      expectedTools: 2,
    },
    fetch,
    (r) => results.push(r),
  );
  return { failures, results, asked, outcome: (name: string) => results.find((r) => r.name.startsWith(name))?.outcome };
}

describe('runSmoke', () => {
  it('passes the stack as it is today, and says what is not deployed yet', async () => {
    const { failures, outcome, results } = await run(false);

    expect(failures).toBe(0);
    expect(outcome('sign-out revokes')).toBe('pass');
    expect(outcome('GET /api/account/export')).toBe('skip');
    expect(outcome('DELETE /api/account')).toBe('skip');
    expect(results.find((r) => r.name === 'MCP round trip')?.outcome).toBe('info');
  });

  it('checks everything #70 adds once it is live, and deletes the guest last', async () => {
    const { failures, outcome, asked } = await run(true, { securityHeaders: true, accountData: true });

    expect(failures).toBe(0);
    for (const name of ['GET /api/account/export', 'GET /account/sign-out', 'sign-out revokes', 'DELETE /api/account']) expect(outcome(name)).toBe('pass');
    expect(asked.filter((a) => a.startsWith('DELETE'))).toEqual(['DELETE /api/account']);
    expect(asked.at(-1)).toBe('GET /api/me');
  });

  it('fails what the checkout says is deployed but the stack does not have', async () => {
    const { failures, outcome } = await run(false, { securityHeaders: true, accountData: true });

    expect(outcome('GET /api/account/export')).toBe('fail');
    expect(outcome('DELETE /api/account')).toBe('fail');
    expect(failures).toBeGreaterThanOrEqual(5);
  });
});
