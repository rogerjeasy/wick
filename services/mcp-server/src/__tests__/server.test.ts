import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createApp } from '../server.js';
import { __resetAuthStateForTest } from '../auth.js';

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>('@aws-sdk/client-dynamodb');
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ Item: undefined }),
    })),
  };
});

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

interface RegisteredClient {
  client_id: string;
  redirect_uris: string[];
}

interface TokenResponse {
  access_token: string;
}

/** Runs the same authorization-code + PKCE flow as auth.test.ts to get a real bearer token. */
async function obtainAccessToken(base: string): Promise<string> {
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
  const client = (await regRes.json()) as RegisteredClient;

  const verifier = 'a'.repeat(64);
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url');

  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', client.redirect_uris[0]!);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const html = await authorizeRes.text();
  const approveHrefMatch = html.match(/href="([^"]+)"/);
  if (!approveHrefMatch) throw new Error('approve link not found in consent page');
  const approveHref = approveHrefMatch[1]!;

  const approveRes = await fetch(approveHref, { redirect: 'manual' });
  const location = new URL(approveRes.headers.get('location')!);
  const code = location.searchParams.get('code')!;

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirect_uris[0]!,
      client_id: client.client_id,
      code_verifier: verifier,
    }),
  });
  const tokens = (await tokenRes.json()) as TokenResponse;
  return tokens.access_token;
}

describe('createApp', () => {
  beforeEach(() => {
    __resetAuthStateForTest();
  });

  it('exposes the MCP endpoint and requires auth', async () => {
    const app = createApp(new URL('http://127.0.0.1:4001'));
    const { port, close } = await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    await close();
  });

  it('completes a real multi-request session: initialize, then reuses the session id on a subsequent request without 400ing', async () => {
    const app = createApp(new URL('http://127.0.0.1:4001'));
    const { port, close } = await listen(app);
    const base = `http://127.0.0.1:${port}`;
    const accessToken = await obtainAccessToken(base);

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.1.0' });

    // `client.connect` performs the `initialize` handshake (which allocates the
    // session and stores its transport in server.ts's session map) followed
    // immediately by the mandatory `notifications/initialized` — itself the very
    // next request after `initialize`, and exactly the request that 400'd before
    // this fix (a fresh, unconnected transport per request never reaches
    // `_initialized`). If `connect` resolves at all, that request already succeeded.
    // Same `exactOptionalPropertyTypes` accessor-vs-optional-property mismatch as
    // server.ts's own transport cast: `sessionId` is `string | undefined` on the
    // class but `string` (optional) on `Transport`. Structurally compatible
    // (verified: StreamableHTTPClientTransport `implements Transport`, SDK 1.30.0).
    await client.connect(transport as unknown as Transport);
    expect(transport.sessionId).toBeDefined();

    // A THIRD request, still carrying the same Mcp-Session-Id, reusing the same
    // stored transport instance. This is the request the reviewer specifically
    // called out as needing coverage.
    const listResult = await client.listTools();
    expect(Array.isArray(listResult.tools)).toBe(true);
    expect(listResult.tools.some((t) => t.name === 'get_resident_shared_view')).toBe(true);

    // And a real tools/call against get_resident_shared_view on that same session,
    // proving the reused transport actually dispatches tool calls end to end.
    const callResult = await client.callTool({ name: 'get_resident_shared_view', arguments: {} });
    const content = callResult.content as { type: string; text: string }[];
    expect(() => JSON.parse(content[0]!.text)).not.toThrow();

    await client.close();
    await close();
  });
});
