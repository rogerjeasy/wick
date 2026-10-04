import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DEMO_ACCOUNTS_PER_HOUR } from '../accounts/demo.js';
import {
  approve,
  beginAuthorize,
  Browser,
  exchangeCode,
  linkNewOrganiser,
  registerClient,
  startServer,
  type Harness,
  type OAuthClient,
  type Tokens,
} from './harness.js';
import type { AppDeps } from '../server.js';
import { createMemoryStore } from '../accounts/__tests__/memoryStore.js';

const closers: (() => Promise<void>)[] = [];

async function server(overrides: Partial<AppDeps> = { demoAccounts: true }): Promise<Harness> {
  const harness = await startServer(overrides);
  closers.push(harness.close);
  return harness;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface Me {
  user: { userId: string; name: string; email: string; guest: boolean };
  household: { householdId: string; name: string; residentName: string };
  membership: { role: string; status: string };
}

const me = async (h: Harness, accessToken: string): Promise<Me> =>
  (await (await fetch(`${h.base}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } })).json()) as Me;

/** One click on the family app's demo button: /authorize with demo=1, then wherever the browser is sent. */
async function clickDemo(h: Harness, browser = new Browser(h.base), client?: OAuthClient) {
  const oauthClient = client ?? (await registerClient(h.base));
  const tx = await beginAuthorize(browser, oauthClient, { demo: '1' });
  const res = await browser.get(`/account?tx=${tx}`);
  return { res, tx, browser, client: oauthClient };
}

async function demoTokens(h: Harness, browser?: Browser): Promise<{ tokens: Tokens; browser: Browser }> {
  const clicked = await clickDemo(h, browser);
  const code = new URL(clicked.res.headers.get('location')!).searchParams.get('code')!;
  const tokens = (await (await exchangeCode(h.base, clicked.client, code)).json()) as Tokens;
  return { tokens, browser: clicked.browser };
}

describe('the demo button — an anonymous account in one click', () => {
  it('goes straight back to the app with a code: no email, no password, no code to confirm, no page to fill in', async () => {
    const h = await server();

    const { res, client } = await clickDemo(h);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(client.redirectUri);
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  it('makes a guest with no email, and a demo home of their own to organise', async () => {
    const h = await server();

    const { tokens } = await demoTokens(h);

    expect(await me(h, tokens.access_token)).toMatchObject({
      user: { name: 'Guest', email: '', guest: true },
      household: { name: 'Demo home', residentName: 'Margaret' },
      membership: { role: 'organiser', status: 'pending' },
    });
  });

  it('gives every click its own account and its own home: two visitors never share one', async () => {
    const h = await server();

    const a = await me(h, (await demoTokens(h)).tokens.access_token);
    const b = await me(h, (await demoTokens(h)).tokens.access_token);

    expect(a.user.userId).not.toBe(b.user.userId);
    expect(a.household.householdId).not.toBe(b.household.householdId);
  });

  it('remembers the browser: clicking again returns the same guest, not a second one', async () => {
    const h = await server();
    const first = await demoTokens(h);

    const again = await demoTokens(h, first.browser);

    expect((await me(h, again.tokens.access_token)).user.userId).toBe((await me(h, first.tokens.access_token)).user.userId);
  });

  it('is offered on the sign-in page too, where it still ends with an explicit Approve', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client);

    const signIn = await (await browser.get(`/account?tx=${tx}`)).text();
    expect(signIn).toContain('Try the demo');
    expect(signIn).toContain('action="/account/demo"');

    const consent = await browser.follow(await browser.post('/account/demo', { tx }));
    const html = await consent.text();
    expect(html).toContain('Demo home');
    expect(html).toContain('Approve');
    expect(html).toContain('Signed in as Guest');
  });
});

describe('a guest is a person like any other', () => {
  it('INV-9: is told to wait for the resident, and reads nothing, until Allow is pressed on a television', async () => {
    const h = await server();
    const { tokens } = await demoTokens(h);
    const transport = new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
    });
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    await client.connect(transport as unknown as Transport);
    closers.push(() => client.close());

    const result = await client.callTool({ name: 'get_today', arguments: {} });

    expect((result.content as { text: string }[])[0]!.text).toContain('Margaret hasn’t allowed this yet');
  });

  it('puts the question to the resident: a card for the television, like for any organiser', async () => {
    const h = await server();
    const guest = await me(h, (await demoTokens(h)).tokens.access_token);

    expect(h.cards.map((c) => c.id)).toEqual([`circle-${guest.user.userId}`]);
    expect(h.cards[0]!.card).toMatchObject({ householdId: guest.household.householdId, personName: 'Guest' });
  });

  it('INV-8: cannot be used to reach anybody else’s home', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const guest = await demoTokens(h);

    const res = await guest.browser.post('/account/approve', {
      tx: await beginAuthorize(guest.browser, await registerClient(h.base)),
      householdId: sarah.householdId,
    });

    expect(res.status).toBe(403);
  });
});

describe('the demo never signs a real person in to something they did not choose', () => {
  it('shows someone already signed in to a real account the usual Approve page, not an automatic one', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    const { res } = await clickDemo(h, sarah.browser);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Approve');
    expect(html).toContain('Signed in as Sarah');
  });

  it('a real account’s approval still works as before with the demo switched on', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(sarah.browser, client);

    expect(await approve(sarah.browser, tx, sarah.householdId)).toBeTruthy();
  });
});

describe('the demo is a switch, off unless the deployment turns it on', () => {
  it('is not offered, and demo=1 leads to the ordinary sign-in page', async () => {
    const h = await server({});

    const { res } = await clickDemo(h);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in to Wick');
    expect(html).not.toContain('Try the demo');
  });

  it('refuses a post to the demo route, and creates nothing', async () => {
    const h = await server({});
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));

    const res = await browser.post('/account/demo', { tx });

    expect(res.status).toBe(404);
    expect(h.cards).toEqual([]);
  });

  it('tells the family app whether to show the button', async () => {
    const on = await server();
    const off = await server({});

    const read = async (h: Harness) => {
      const res = await fetch(`${h.base}/account/options`);
      return { cors: res.headers.get('access-control-allow-origin'), body: await res.json() };
    };

    expect(await read(on)).toEqual({ cors: '*', body: { demo: true } });
    expect(await read(off)).toEqual({ cors: '*', body: { demo: false } });
  });
});

describe('the demo cannot be used to fill the table', () => {
  it('stops making guests past the hourly limit, says so in words, and starts again the next hour', async () => {
    let clock = 1_790_000_000_000;
    // One clock for the server and its store, so a pending sign-in does not look expired.
    const h = await server({ demoAccounts: true, now: () => clock, store: createMemoryStore(() => clock) });
    // One registered app for every visitor, as in life: registration has its own, stricter limit.
    const client = await registerClient(h.base);
    const click = () => clickDemo(h, new Browser(h.base), client);
    for (let i = 0; i < DEMO_ACCOUNTS_PER_HOUR; i++) expect((await click()).res.status).toBe(302);

    const refused = (await click()).res;
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain('The demo is busy');
    expect(h.cards).toHaveLength(DEMO_ACCOUNTS_PER_HOUR);

    clock += 60 * 60 * 1000 + 1;
    expect((await click()).res.status).toBe(302);
  });
});
