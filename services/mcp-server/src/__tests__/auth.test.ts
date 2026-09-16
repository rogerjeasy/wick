import { describe, expect, it } from 'vitest';
import express from 'express';
import { createAuthRouter, requireAuth, __resetAuthStateForTest } from '../auth.js';

const ISSUER = new URL('http://127.0.0.1:4000');

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

interface TokenResponse {
  access_token: string;
}

function testApp() {
  __resetAuthStateForTest();
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(ISSUER));
  app.get('/protected', requireAuth(), (req, res) => {
    res.json({ ok: true, clientId: req.auth?.clientId });
  });
  return app;
}

async function registerClient(app: express.Express) {
  const res = await fetch(`http://127.0.0.1:${await listen(app)}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['http://127.0.0.1:9999/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  return res.json();
}

function listen(app: express.Express): Promise<number> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

describe('auth', () => {
  it('serves protected resource metadata', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource?: string };
    expect(body.resource).toBeDefined();
  });

  it('serves authorization server metadata advertising S256 PKCE', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code_challenge_methods_supported?: string[] };
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('returns 401 with no WWW-Authenticate header when unauthenticated', async () => {
    const app = testApp();
    const port = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/protected`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('completes the full authorization-code + PKCE flow and authenticates with the resulting token', async () => {
    const app = testApp();
    const port = await listen(app);
    const base = `http://127.0.0.1:${port}`;

    const regRes = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9999/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(regRes.status).toBe(201);
    const client = (await regRes.json()) as RegisteredClient;

    const verifier = 'a'.repeat(64);
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    )
      .toString('base64url');

    const authorizeUrl = new URL(`${base}/authorize`);
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', client.redirect_uris[0]!);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'xyz');

    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(200);
    const html = await authorizeRes.text();
    const approveHref = html.match(/href="([^"]+)"/)?.[1];
    expect(approveHref).toBeDefined();

    const approveRes = await fetch(approveHref!, { redirect: 'manual' });
    expect(approveRes.status).toBe(302);
    const location = new URL(approveRes.headers.get('location')!);
    const code = location.searchParams.get('code');
    expect(location.searchParams.get('state')).toBe('xyz');
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: client.redirect_uris[0]!,
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as TokenResponse;
    expect(tokens.access_token).toBeTruthy();

    const protectedRes = await fetch(`${base}/protected`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(protectedRes.status).toBe(200);
    const body = (await protectedRes.json()) as { clientId?: string };
    expect(body.clientId).toBe(client.client_id);
  });
});
