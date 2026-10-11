/**
 * A guest's access token, got the way the family app's "Try the demo" button
 * gets one (apps/sim-alexa/main.js `connect({ demo: true })`): register a
 * client, start an authorisation with PKCE and `demo=1`, follow the server's
 * two redirects, exchange the code.
 *
 * It makes one guest account and one demo home on the server asked — what
 * any visitor's click makes — and touches no home a person set up. Guests
 * are made at a bounded rate (services/mcp-server/src/accounts/demo.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Fetch } from './preflight.js';

/** Never fetched: the code is read off the redirect, not delivered to it. */
const REDIRECT_URI = 'http://127.0.0.1:9/addon-check';

const base64Url = (bytes: Buffer): string => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function demoToken(serverUrl: string, fetch: Fetch): Promise<string> {
  const metadata = (await (await fetch(`${serverUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;

  const registered = await fetch(String(metadata.registration_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: 'the Wick add-on check',
    }),
  });
  if (!registered.ok) throw new Error(`client registration answered ${registered.status}`);
  const client = (await registered.json()) as { client_id: string };

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const authorize = new URL(String(metadata.authorization_endpoint));
  authorize.searchParams.set('client_id', client.client_id);
  authorize.searchParams.set('redirect_uri', REDIRECT_URI);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('demo', '1');

  // authorize → /account?tx=… → the redirect URI with ?code=…
  let next = authorize.toString();
  let code: string | null = null;
  for (let hop = 0; hop < 4 && !code; hop += 1) {
    const res = await fetch(next, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (!location) {
      throw new Error(res.status === 429 ? 'the server has made its guests for this hour; try later' : `no demo account was offered (${res.status}); is demo_accounts on?`);
    }
    const target = new URL(location, next);
    code = target.toString().startsWith(REDIRECT_URI) ? target.searchParams.get('code') : null;
    next = target.toString();
  }
  if (!code) throw new Error('the server never came back with a code');

  const exchanged = await fetch(String(metadata.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: client.client_id, code_verifier: verifier }),
  });
  if (!exchanged.ok) throw new Error(`token exchange answered ${exchanged.status}`);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}
