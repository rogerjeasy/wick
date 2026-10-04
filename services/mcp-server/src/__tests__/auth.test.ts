import { afterEach, describe, expect, it } from 'vitest';
import {
  approve,
  beginAuthorize,
  Browser,
  CONFIRMATION_CODE,
  exchangeCode,
  linkInvited,
  linkNewOrganiser,
  registerClient,
  SARAH,
  signUp,
  startServer,
  TOM,
  type Harness,
  type Tokens,
} from './harness.js';

let harness: Harness | undefined;
const closers: (() => Promise<void>)[] = [];

async function server(): Promise<Harness> {
  harness = await startServer();
  closers.push(harness.close);
  return harness;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function whoAmI(base: string, accessToken: string): Promise<Response> {
  return fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${accessToken}` } });
}

describe('what Alexa+ requires of an add-on’s authorization server', () => {
  it('serves protected resource metadata', async () => {
    const h = await server();
    const res = await fetch(`${h.base}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resource?: string }).resource).toBeDefined();
  });

  it('serves authorization server metadata advertising S256 PKCE', async () => {
    const h = await server();
    const res = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code_challenge_methods_supported?: string[] }).code_challenge_methods_supported).toEqual(['S256']);
  });

  it('returns 401 with no WWW-Authenticate header when unauthenticated', async () => {
    const h = await server();
    const res = await fetch(`${h.base}/api/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('returns 401 invalid_token, still with no WWW-Authenticate header, for a token it never issued', async () => {
    const h = await server();
    const res = await whoAmI(h.base, 'totally-garbage-token');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_token');
  });

  it('returns 400 invalid_grant for an authorization code it never issued', async () => {
    const h = await server();
    const client = await registerClient(h.base);
    const res = await exchangeCode(h.base, client, 'never-issued-authorization-code');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_grant');
  });
});

describe('nobody is given a code without signing in', () => {
  it('sends /authorize to a sign-in page', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));

    const page = await browser.get(`/account?tx=${tx}`);

    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Sign in to Wick');
    expect(html).toContain('name="password"');
  });

  it('refuses Approve from a browser that has not signed in', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));

    const res = await browser.post('/account/approve', { tx, householdId: 'margaret' });

    expect(res.headers.get('location') ?? '').not.toContain('code=');
    expect(await (await browser.follow(res)).text()).toContain('Sign in to Wick');
  });

  it('says a sign-in link it does not recognise has expired, instead of failing', async () => {
    const h = await server();

    const page = await new Browser(h.base).get('/account?tx=not-a-real-transaction');

    expect(page.status).toBe(400);
    expect(await page.text()).toContain('This sign-in link has expired');
  });
});

describe('signing up with an email address and a password', () => {
  it('asks for the code that was emailed, then for a sign-in', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));

    const afterSignUp = await browser.follow(await browser.post('/account/sign-up', { tx, ...SARAH }));
    expect(await afterSignUp.text()).toContain('We sent a code to sarah@example.com');

    const afterVerify = await browser.follow(await browser.post('/account/verify', { tx, email: SARAH.email, code: CONFIRMATION_CODE }));
    const html = await afterVerify.text();
    expect(html).toContain('Your email is confirmed');
    expect(html).toContain('Sign in to Wick');
  });

  it('says a wrong code is wrong and lets the person try again', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await browser.post('/account/sign-up', { tx, ...SARAH });

    const page = await browser.follow(await browser.post('/account/verify', { tx, email: SARAH.email, code: '000000' }));

    const html = await page.text();
    expect(html).toContain('That code is not right');
    expect(html).toContain('name="code"');
  });

  it('says an email already has an account', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await signUp(browser, tx, SARAH);

    const page = await browser.follow(await browser.post('/account/sign-up', { tx, ...SARAH, name: 'Someone else' }));

    expect(await page.text()).toContain('There is already an account with that email');
  });

  it('says a wrong password is wrong, without saying whether the email exists', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await signUp(browser, tx, SARAH);
    const fresh = new Browser(h.base);

    const page = await fresh.follow(await fresh.post('/account/sign-in', { tx, email: SARAH.email, password: 'wrong' }));
    const unknown = await fresh.follow(await fresh.post('/account/sign-in', { tx, email: 'nobody@example.com', password: 'wrong' }));

    const message = 'That email and password do not match';
    expect(await page.text()).toContain(message);
    expect(await unknown.text()).toContain(message);
  });

  it('never puts what a person typed into a page unescaped', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));

    const page = await browser.follow(
      await browser.post('/account/sign-in', { tx, email: '"><script>alert(1)</script>', password: 'x' }),
    );

    expect(await page.text()).not.toContain('<script>alert(1)</script>');
  });
});

describe('a new organiser', () => {
  it('is asked who lives at home, and is then offered that household to approve', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await signUp(browser, tx, SARAH);

    const first = await browser.get(`/account?tx=${tx}`);
    expect(await first.text()).toContain('Who is this for?');

    const consent = await browser.follow(await browser.post('/account/household', { tx, residentName: 'Margaret' }));
    const html = await consent.text();
    expect(html).toContain('Margaret’s home');
    expect(html).toContain('Approve');
  });

  it('ends with a token that says who they are and which household it is for', async () => {
    const h = await server();

    const linked = await linkNewOrganiser(h);
    const res = await whoAmI(h.base, linked.tokens.access_token);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { name: 'Sarah', email: 'sarah@example.com' },
      household: { householdId: linked.householdId, residentName: 'Margaret' },
      membership: { role: 'organiser', status: 'pending' },
    });
  });

  it('puts the question to the resident: a card for the television', async () => {
    const h = await server();

    const linked = await linkNewOrganiser(h);

    expect(h.cards.map((c) => c.id)).toEqual([`circle-${linked.userId}`]);
  });
});

describe('INV-8: the household comes from the token, and the token from a membership', () => {
  it('refuses to approve the app for a household the person does not belong to', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client);
    await signUp(browser, tx, TOM);

    const res = await browser.post('/account/approve', { tx, householdId: sarah.householdId });

    expect(res.status).toBe(403);
    expect(res.headers.get('location')).toBeNull();
  });

  it('lets an authorization code be used once', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client);
    await signUp(browser, tx, SARAH);
    await browser.post('/account/household', { tx, residentName: 'Margaret' });
    const [membership] = await h.store.listMemberships((await h.deps.identity.signIn(SARAH)).userId);
    const code = await approve(browser, tx, membership!.householdId);

    expect((await exchangeCode(h.base, client, code)).status).toBe(200);
    expect((await exchangeCode(h.base, client, code)).status).toBe(400);
  });

  it('returns to the app with its state untouched', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client);
    await signUp(browser, tx, SARAH);
    await browser.post('/account/household', { tx, residentName: 'Margaret' });
    const [membership] = await h.store.listMemberships((await h.deps.identity.signIn(SARAH)).userId);

    const res = await browser.post('/account/approve', { tx, householdId: membership!.householdId });

    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(client.redirectUri);
    expect(location.searchParams.get('state')).toBe('xyz');
  });
});

describe('sign-in state outlives the server process', () => {
  it('still accepts a token after a restart — a redeploy no longer signs everyone out', async () => {
    const h = await server();
    const linked = await linkNewOrganiser(h);

    const restarted = await h.restart();
    closers.push(restarted.close);

    expect((await whoAmI(restarted.base, linked.tokens.access_token)).status).toBe(200);
  });

  it('exchanges a refresh token for a new pair, and retires the old one', async () => {
    const h = await server();
    const linked = await linkNewOrganiser(h);
    const refresh = (token: string) =>
      fetch(`${h.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: linked.client.clientId }),
      });

    const first = await refresh(linked.tokens.refresh_token);
    expect(first.status).toBe(200);
    const renewed = (await first.json()) as Tokens;
    expect((await whoAmI(h.base, renewed.access_token)).status).toBe(200);
    expect(renewed.refresh_token).not.toBe(linked.tokens.refresh_token);

    expect((await refresh(linked.tokens.refresh_token)).status).toBe(400);
  });

  it('remembers the browser: a second app is approved without typing the password again', async () => {
    const h = await server();
    const linked = await linkNewOrganiser(h);
    const secondClient = await registerClient(h.base);

    const tx = await beginAuthorize(linked.browser, secondClient);
    const page = await linked.browser.get(`/account?tx=${tx}`);

    const html = await page.text();
    expect(html).not.toContain('name="password"');
    expect(html).toContain('Approve');
  });

  it('forgets the browser on sign-out', async () => {
    const h = await server();
    const linked = await linkNewOrganiser(h);
    const tx = await beginAuthorize(linked.browser, await registerClient(h.base));

    const page = await linked.browser.follow(await linked.browser.post('/account/sign-out', { tx }));

    expect(await page.text()).toContain('Sign in to Wick');
  });
});

describe('an invited family member', () => {
  it('is shown who invited them and to whose home, joins, and waits for the resident', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const invited = await fetch(`${h.base}/api/circle/invitations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sarah.tokens.access_token}` },
    });
    const { code } = (await invited.json()) as { code: string };

    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base), { invite: code });
    await signUp(browser, tx, TOM);
    const page = await browser.get(`/account?tx=${tx}`);
    expect(await page.text()).toContain('Sarah has invited you to Margaret’s home');

    const tom = await linkInvited(h, { ...TOM, email: "tom2@example.com" }, code);
    const me = (await (await whoAmI(h.base, tom.tokens.access_token)).json()) as { household: { householdId: string }; membership: { role: string; status: string } };
    expect(me.household.householdId).toBe(sarah.householdId);
    expect(me.membership).toEqual({ role: 'family', status: 'pending' });
    expect(h.cards.map((c) => c.id)).toContain(`circle-${tom.userId}`);
  });
});

describe('a forgotten password', () => {
  it('is reset with the emailed code, and the new one signs in', async () => {
    const h = await server();
    const browser = new Browser(h.base);
    const client = await registerClient(h.base);
    const tx = await beginAuthorize(browser, client);
    await signUp(browser, tx, SARAH);
    const fresh = new Browser(h.base);

    const asked = await fresh.follow(await fresh.post('/account/forgot', { tx, email: SARAH.email }));
    expect(await asked.text()).toContain('Choose a new password');
    const reset = await fresh.follow(
      await fresh.post('/account/reset', { tx, email: SARAH.email, code: CONFIRMATION_CODE, password: 'a brand new passphrase' }),
    );
    expect(await reset.text()).toContain('Your password is changed');

    const signedIn = await fresh.follow(await fresh.post('/account/sign-in', { tx, email: SARAH.email, password: 'a brand new passphrase' }));
    expect(await signedIn.text()).toContain('Who is this for?');
  });
});

describe('the index that lists a person’s homes is allowed to lag', () => {
  // DynamoDB's index is eventually consistent: a membership written a moment
  // ago may not be listed yet. The pages must not ask "Who is this for?" a
  // second time, which would make a second household.
  async function serverWithLaggingIndex(): Promise<Harness> {
    const real = await startServer();
    await real.close();
    const lagging = { ...real.deps, store: { ...real.deps.store, listMemberships: async () => [] } };
    const h = await startServer(lagging);
    closers.push(h.close);
    return h;
  }

  it('offers the home just set up, even before the index lists it', async () => {
    const h = await serverWithLaggingIndex();
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await signUp(browser, tx, SARAH);

    const page = await browser.follow(await browser.post('/account/household', { tx, residentName: 'Margaret' }));

    const html = await page.text();
    expect(html).not.toContain('Who is this for?');
    expect(html).toContain('Margaret’s home');
    expect(html).toContain('Approve');
  });

  it('will not offer a home the person does not belong to, whatever the address says', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const browser = new Browser(h.base);
    const tx = await beginAuthorize(browser, await registerClient(h.base));
    await signUp(browser, tx, TOM);

    const page = await browser.get(`/account?tx=${tx}&home=${sarah.householdId}`);

    const html = await page.text();
    expect(html).toContain('Who is this for?');
    expect(html).not.toContain('Margaret’s home');
  });
});

describe('rate limits count the visitor, not the proxy in front of the server', () => {
  // Deployed, every request arrives from App Runner's own address. Counted
  // by that address, the SDK's limit of 20 app registrations an hour would be
  // 20 for the whole world: the twenty-first person to press "Sign in" in an
  // hour would be refused, whoever they were.
  const register = (base: string, visitor: string) =>
    fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': visitor },
      body: JSON.stringify({
        redirect_uris: ['https://family.example/'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });

  it('lets many different visitors register the app in the same hour', async () => {
    const h = await startServer({}, 'https://wick.example');
    closers.push(h.close);

    for (let i = 0; i < 25; i++) expect((await register(h.base, `203.0.113.${i}`)).status).toBe(201);
  });

  it('still stops one visitor who keeps registering', async () => {
    const h = await startServer({}, 'https://wick.example');
    closers.push(h.close);

    const statuses = [];
    for (let i = 0; i < 22; i++) statuses.push((await register(h.base, '203.0.113.7')).status);

    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses[21]).toBe(429);
  });
});
