/**
 * Test-only: a whole Wick server on a real socket, with an in-memory store,
 * an in-memory identity provider and a browser-like client that walks the
 * same pages a person would.
 */
import type express from 'express';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import { createApp, type AppDeps } from '../server.js';
import { IdentityError, normaliseEmail, type IdentityProvider } from '../accounts/identity.js';
import { createMemoryStore, type MemoryStore } from '../accounts/__tests__/memoryStore.js';

export const CONFIRMATION_CODE = '123456';

/** An identity provider that keeps its users in memory. Every confirmation code is CONFIRMATION_CODE. */
export function createFakeIdentity(): IdentityProvider {
  const users = new Map<string, { password: string; name: string; confirmed: boolean; userId: string }>();
  let next = 0;
  return {
    async signUp({ email, password, name }) {
      const key = normaliseEmail(email);
      if (users.has(key)) throw new IdentityError('email_taken');
      if (password.length < 8) throw new IdentityError('weak_password');
      users.set(key, { password, name, confirmed: false, userId: `u_${++next}` });
    },
    async confirmSignUp({ email, code }) {
      const user = users.get(normaliseEmail(email));
      if (!user || code.trim() !== CONFIRMATION_CODE) throw new IdentityError('bad_code');
      user.confirmed = true;
    },
    async resendCode() {},
    async signIn({ email, password }) {
      const key = normaliseEmail(email);
      const user = users.get(key);
      if (!user || user.password !== password) throw new IdentityError('wrong_credentials');
      if (!user.confirmed) throw new IdentityError('not_confirmed');
      return { userId: user.userId, email: key, name: user.name };
    },
    async forgotPassword() {},
    async resetPassword({ email, code, password }) {
      const user = users.get(normaliseEmail(email));
      if (!user || code.trim() !== CONFIRMATION_CODE) throw new IdentityError('bad_code');
      user.password = password;
    },
    async deleteAccount({ email, password }) {
      const key = normaliseEmail(email);
      const user = users.get(key);
      if (!user || user.password !== password) throw new IdentityError('wrong_credentials');
      users.delete(key);
    },
  };
}

export interface Harness {
  readonly base: string;
  readonly store: MemoryStore;
  readonly cards: QueuedCard[];
  readonly deps: AppDeps;
  /** A second server process over the same store and identities — a redeploy. */
  restart(): Promise<Harness>;
  close(): Promise<void>;
}

function listen(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // On 127.0.0.1, where the tests call it. Listening on every interface
    // lets the OS hand out a port some other program already holds on
    // loopback, and that program then answers the test's request.
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

export async function startServer(overrides: Partial<AppDeps> = {}, issuer = 'http://127.0.0.1:4000'): Promise<Harness> {
  const cards: QueuedCard[] = [];
  const deps: AppDeps = {
    store: createMemoryStore(),
    identity: createFakeIdentity(),
    sendCard: async (card) => void cards.push(card),
    sendPatch: async () => {},
    withdrawCard: async () => {},
    ddb: { send: async () => ({}) } as unknown as DynamoDBClient,
    ...overrides,
  };
  const start = async (): Promise<Harness> => {
    const { port, close } = await listen(createApp(new URL(issuer), deps));
    return { base: `http://127.0.0.1:${port}`, store: deps.store as MemoryStore, cards, deps, restart: start, close };
  };
  return start();
}

/** Keeps cookies between requests and never follows a redirect by itself, like a careful browser. */
export class Browser {
  #cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.#cookies.size) headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(path.startsWith('http') ? path : `${this.base}${path}`, { ...init, headers, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = pair!.split('=');
      if (value) this.#cookies.set(name!, value);
      else this.#cookies.delete(name!);
    }
    return res;
  }

  get(path: string): Promise<Response> {
    return this.request(path);
  }

  post(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  }

  /** Follows same-origin redirects until a page (or a redirect away from this server) comes back. */
  async follow(res: Response): Promise<Response> {
    let current = res;
    while (current.status >= 300 && current.status < 400) {
      const location = current.headers.get('location')!;
      if (location.startsWith('http') && !location.startsWith(this.base)) return current;
      current = await this.get(location);
    }
    return current;
  }
}

export interface OAuthClient {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly verifier: string;
}

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

const REDIRECT_URI = 'http://127.0.0.1:9999/callback';

export async function registerClient(base: string): Promise<OAuthClient> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = (await res.json()) as { client_id: string };
  return { clientId: client.client_id, redirectUri: REDIRECT_URI, verifier: 'a'.repeat(64) };
}

/** Opens /authorize as the app would, and returns the transaction id the sign-in pages carry. */
export async function beginAuthorize(browser: Browser, client: OAuthClient, extra: Record<string, string> = {}): Promise<string> {
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client.verifier))).toString('base64url');
  const url = new URL(`${browser.base}/authorize`);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'xyz');
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  const res = await browser.get(url.toString());
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`authorize did not redirect: ${res.status} ${await res.text()}`);
  const tx = new URL(location, browser.base).searchParams.get('tx');
  if (!tx) throw new Error('authorize redirect carried no tx');
  return tx;
}

export async function exchangeCode(base: string, client: OAuthClient, code: string): Promise<Response> {
  return fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: client.verifier,
    }),
  });
}

export interface Person {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export const SARAH: Person = { name: 'Sarah', email: 'sarah@example.com', password: 'correct horse battery' };
export const TOM: Person = { name: 'Tom', email: 'tom@example.com', password: 'a different passphrase' };

export async function signUp(browser: Browser, tx: string, person: Person): Promise<void> {
  await browser.post('/account/sign-up', { tx, ...person });
  await browser.post('/account/verify', { tx, email: person.email, code: CONFIRMATION_CODE });
  await browser.post('/account/sign-in', { tx, email: person.email, password: person.password });
}

/** Presses Approve and returns the authorization code the app is redirected back with. */
export async function approve(browser: Browser, tx: string, householdId: string): Promise<string> {
  const res = await browser.post('/account/approve', { tx, householdId });
  const location = res.headers.get('location');
  if (res.status !== 302 || !location) throw new Error(`approve did not redirect: ${res.status} ${await res.text()}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('approve redirect carried no code');
  return code;
}

export interface Linked {
  readonly tokens: Tokens;
  readonly householdId: string;
  readonly userId: string;
  readonly browser: Browser;
  readonly client: OAuthClient;
}

/**
 * The whole journey of a new organiser: sign up, confirm the email, sign
 * in, name the person at home, approve the app.
 */
export async function linkNewOrganiser(h: Harness, person: Person = SARAH, residentName = 'Margaret'): Promise<Linked> {
  const browser = new Browser(h.base);
  const client = await registerClient(h.base);
  const tx = await beginAuthorize(browser, client);
  await signUp(browser, tx, person);
  await browser.post('/account/household', { tx, residentName, timeZone: 'Europe/London' });
  const user = await signedInUserId(h, person);
  const [membership] = await h.store.listMemberships(user);
  const code = await approve(browser, tx, membership!.householdId);
  const tokens = (await (await exchangeCode(h.base, client, code)).json()) as Tokens;
  return { tokens, householdId: membership!.householdId, userId: user, browser, client };
}

/** Someone who follows an invitation link: sign up, join, approve the app. */
export async function linkInvited(h: Harness, person: Person, invite: string): Promise<Linked> {
  const browser = new Browser(h.base);
  const client = await registerClient(h.base);
  const tx = await beginAuthorize(browser, client, { invite });
  await signUp(browser, tx, person);
  await browser.post('/account/join', { tx });
  const user = await signedInUserId(h, person);
  const [membership] = await h.store.listMemberships(user);
  const code = await approve(browser, tx, membership!.householdId);
  const tokens = (await (await exchangeCode(h.base, client, code)).json()) as Tokens;
  return { tokens, householdId: membership!.householdId, userId: user, browser, client };
}

async function signedInUserId(h: Harness, person: Person): Promise<string> {
  const who = await h.deps.identity.signIn({ email: person.email, password: person.password });
  return who.userId;
}

/** What the resident's press on the Circle card does (services/edge-device/lambda/circle.mjs). */
export async function residentAllows(h: Harness, householdId: string, userId: string): Promise<void> {
  await h.store.setMemberStatus(householdId, userId, 'allowed', Date.now());
}
