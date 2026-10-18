/**
 * RFC 8707: every token is for this server and no other. A client may name
 * the resource it wants a token for; another server's is refused, and a
 * token is bound to this one when the client named none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hashToken } from '../accounts/tokens.js';
import {
  Browser,
  SARAH,
  approve,
  beginAuthorize,
  exchangeCode,
  registerClient,
  residentAllows,
  signUp,
  startServer,
  type Harness,
  type Tokens,
} from './harness.js';

const ISSUER = 'http://127.0.0.1:4000';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function wick(): Promise<Harness> {
  const h = await startServer({}, ISSUER);
  closers.push(h.close);
  return h;
}

/** An organiser's whole sign-in, with `extra` on /authorize, up to the code; then the exchange, with `tokenExtra`. */
async function link(h: Harness, extra: Record<string, string> = {}, tokenExtra: Record<string, string> = {}) {
  const browser = new Browser(h.base);
  const client = await registerClient(h.base);
  const tx = await beginAuthorize(browser, client, extra);
  await signUp(browser, tx, SARAH);
  await browser.post('/account/household', { tx, residentName: 'Margaret', timeZone: 'Europe/London' });
  const userId = (await h.deps.identity.signIn({ email: SARAH.email, password: SARAH.password })).userId;
  const [membership] = await h.store.listMemberships(userId);
  const code = await approve(browser, tx, membership!.householdId);
  const exchanged = Object.keys(tokenExtra).length
    ? await fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: client.redirectUri, client_id: client.clientId, code_verifier: client.verifier, ...tokenExtra }),
      })
    : await exchangeCode(h.base, client, code);
  return { exchanged, client, householdId: membership!.householdId, userId };
}

const toolsList = (h: Harness, token: string) =>
  fetch(`${h.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });

const storedResource = async (h: Harness, accessToken: string): Promise<string | undefined> =>
  (await h.store.getRecord<{ resource?: string }>('OAUTH#AT', hashToken(accessToken)))?.resource;

describe('token audience (RFC 8707)', () => {
  it('binds a token to this server when the client named no resource', async () => {
    const h = await wick();
    const { exchanged } = await link(h);
    const tokens = (await exchanged.json()) as Tokens;

    expect(await storedResource(h, tokens.access_token)).toBe(`${ISSUER}/`);
    expect((await toolsList(h, tokens.access_token)).status).toBe(200);
  });

  it('takes this server named as its MCP endpoint, which is this server', async () => {
    const h = await wick();
    const { exchanged } = await link(h, { resource: `${ISSUER}/mcp` }, { resource: `${ISSUER}/mcp` });
    const tokens = (await exchanged.json()) as Tokens;

    expect(await storedResource(h, tokens.access_token)).toBe(`${ISSUER}/mcp`);
    expect((await toolsList(h, tokens.access_token)).status).toBe(200);
  });

  it('refuses to begin a sign-in for another server: back to the app with invalid_target, and nothing parked', async () => {
    const h = await wick();
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const url = new URL(`${h.base}/authorize`);
    for (const [k, v] of Object.entries({ client_id: client.clientId, redirect_uri: client.redirectUri, response_type: 'code', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: 'https://elsewhere.example/mcp' })) url.searchParams.set(k, v);

    const res = await browser.get(url.toString());

    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(client.redirectUri);
    expect(back.searchParams.get('error')).toBe('invalid_target');
  });

  it('refuses a code exchanged for another resource than it was approved for', async () => {
    const h = await wick();
    const { exchanged } = await link(h, {}, { resource: 'https://elsewhere.example/' });

    expect(exchanged.status).toBe(400);
    expect(((await exchanged.json()) as { error: string }).error).toBe('invalid_target');
  });

  it('refuses a refresh for another resource, and the refresh token stays good', async () => {
    const h = await wick();
    const { exchanged, client } = await link(h);
    const tokens = (await exchanged.json()) as Tokens;
    const refresh = (extra: Record<string, string>) =>
      fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.clientId, ...extra }),
      });

    const refused = await refresh({ resource: 'https://elsewhere.example/mcp' });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('invalid_target');

    const renewed = await refresh({});
    expect(renewed.status).toBe(200);
    expect(await storedResource(h, ((await renewed.json()) as Tokens).access_token)).toBe(`${ISSUER}/`);
  });

  it('refuses at every request a token bound to another resource', async () => {
    const h = await wick();
    const { exchanged, householdId, userId } = await link(h);
    await residentAllows(h, householdId, userId);
    const { access_token } = (await exchanged.json()) as Tokens;
    const record = (await h.store.getRecord<Record<string, unknown>>('OAUTH#AT', hashToken(access_token)))!;
    await h.store.putRecord('OAUTH#AT', hashToken(access_token), { ...record, resource: 'https://elsewhere.example/mcp' }, Date.now() + 60_000);

    const res = await toolsList(h, access_token);

    expect(res.status).toBe(401);
    // Amazon's Alexa+ add-on guidance: a 401 carries no WWW-Authenticate (auth.ts).
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('lets a token issued before tokens were bound, which names no resource, live out its hour', async () => {
    const h = await wick();
    const { exchanged } = await link(h);
    const { access_token } = (await exchanged.json()) as Tokens;
    const { resource: _bound, ...unbound } = (await h.store.getRecord<Record<string, unknown>>('OAUTH#AT', hashToken(access_token)))!;
    await h.store.putRecord('OAUTH#AT', hashToken(access_token), unbound, Date.now() + 60_000);

    expect((await toolsList(h, access_token)).status).toBe(200);
  });
});
