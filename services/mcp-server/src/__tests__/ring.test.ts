import { afterEach, describe, expect, it } from 'vitest';
import { ringLinkView, type RingLinkAnswer, type RingLinks } from '../accounts/apiRouter.js';
import { invokedRingLinks } from '../accounts/ringLinks.js';
import { linkInvited, linkNewOrganiser, residentAllows, startServer, TOM, type Harness, type Linked } from './harness.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const TOKEN = 'playground-token-0123456789abcdef';

/** The linking function, standing in: it keeps a link per household and records how it was asked. */
function fakeRingLinks(options: { playgroundAllowed?: boolean } = {}) {
  const linked = new Map<string, RingLinkAnswer>();
  const calls: { action: string; householdId: string; userId?: string; token?: string }[] = [];
  const playgroundAllowed = options.playgroundAllowed ?? true;
  const statusOf = (householdId: string): RingLinkAnswer => linked.get(householdId) ?? { ok: true, linked: false, playgroundAllowed };
  const links: RingLinks = {
    async status(householdId) {
      calls.push({ action: 'status', householdId });
      return statusOf(householdId);
    },
    async start(householdId, userId) {
      calls.push({ action: 'start', householdId, userId });
      return { ok: true, url: 'https://account.ring.com/account/integrations/partner-link/authorize?state=abc' };
    },
    async playground(householdId, userId, token) {
      calls.push({ action: 'playground', householdId, userId, token });
      if (token !== TOKEN) return { ok: false, error: 'token_refused' };
      linked.set(householdId, {
        ok: true,
        linked: true,
        source: 'playground',
        simulated: true,
        linkedAt: 1,
        expiresAt: 2,
        refreshable: false,
        expired: false,
        devices: [{ id: 'ava1.ring.device.SECRET-ID', name: 'Front Door' }],
        heldElsewhere: 0,
        playgroundAllowed,
      });
      return statusOf(householdId);
    },
    async disconnect(householdId) {
      calls.push({ action: 'disconnect', householdId });
      linked.delete(householdId);
      return statusOf(householdId);
    },
  };
  return { links, calls };
}

async function server(ring = fakeRingLinks()): Promise<{ h: Harness; calls: ReturnType<typeof fakeRingLinks>['calls'] }> {
  const h = await startServer({ ringLinks: ring.links });
  closers.push(h.close);
  return { h, calls: ring.calls };
}

const api = (h: Harness, who: Linked, path: string, init: RequestInit = {}) =>
  fetch(`${h.base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${who.tokens.access_token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });

const paste = (h: Harness, who: Linked, body: unknown) => api(h, who, '/api/ring/playground', { method: 'POST', body: JSON.stringify(body) });

describe('GET /api/ring', () => {
  it('tells the organiser their home has no doorbell connected yet', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await api(h, sarah, '/api/ring');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: false, playgroundAllowed: true });
  });

  it('asks about the household in the organiser\'s own token', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);

    await api(h, sarah, '/api/ring?householdId=someone-elses-home');

    expect(calls).toEqual([{ action: 'status', householdId: sarah.householdId }]);
  });
});

describe('POST /api/ring/playground — connecting with a token from Ring\'s simulator', () => {
  it('connects the organiser\'s home, and says it is the simulator', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await paste(h, sarah, { token: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ linked: true, source: 'playground', simulated: true, cameras: ['Front Door'], refreshable: false });
    expect(calls).toEqual([{ action: 'playground', householdId: sarah.householdId, userId: sarah.userId, token: TOKEN }]);
  });

  it('INV-8: ignores a household named in the request — the token\'s household is the only one', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);

    await paste(h, sarah, { token: TOKEN, householdId: 'margaret', userId: 'someone-else' });

    expect(calls[0]).toMatchObject({ householdId: sarah.householdId, userId: sarah.userId });
  });

  it('never sends the token back, nor Ring\'s identifier for the camera', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);

    const body = await (await paste(h, sarah, { token: TOKEN })).text();
    const later = await (await api(h, sarah, '/api/ring')).text();

    for (const text of [body, later]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('SECRET-ID');
    }
  });

  it('says plainly when Ring refuses the token', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await paste(h, sarah, { token: 'a-token-ring-has-never-seen-0123' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'token_refused', message: expect.stringContaining('half an hour') });
  });

  it('refuses a request with no token in it, without asking the linking function', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await paste(h, sarah, { code: '123456' });

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('passes on only a refusal it recognises — anything else is "could not be reached"', async () => {
    const ring = fakeRingLinks();
    ring.links.playground = async () => ({ ok: false, error: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:wick/ring/tokens/hh' });
    const { h } = await server(ring);
    const sarah = await linkNewOrganiser(h);

    const res = await paste(h, sarah, { token: TOKEN });

    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('arn:aws');
    expect(JSON.parse(text).error).toBe('ring_unavailable');
  });
});

describe('who may connect a home to Ring', () => {
  it('only the organiser: a family member is refused on every route, even once the resident has allowed them', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);
    const invitation = ((await (await api(h, sarah, '/api/circle/invitations', { method: 'POST' })).json()) as { code: string }).code;
    const tom = await linkInvited(h, TOM, invitation);
    await residentAllows(h, tom.householdId, tom.userId);

    const attempts = await Promise.all([
      api(h, tom, '/api/ring'),
      api(h, tom, '/api/ring/link', { method: 'POST' }),
      paste(h, tom, { token: TOKEN }),
      api(h, tom, '/api/ring', { method: 'DELETE' }),
    ]);

    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(calls).toEqual([]);
  });

  it('nobody without a token', async () => {
    const { h, calls } = await server();

    const res = await fetch(`${h.base}/api/ring`);

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('one home\'s organiser cannot see or touch another home\'s link', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    const other = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Arun');
    await paste(h, sarah, { token: TOKEN });

    expect(await (await api(h, other, '/api/ring')).json()).toEqual({ linked: false, playgroundAllowed: true });

    await api(h, other, '/api/ring', { method: 'DELETE' });
    expect(await (await api(h, sarah, '/api/ring')).json()).toMatchObject({ linked: true });
  });
});

describe('POST /api/ring/link — Ring\'s own sign-in', () => {
  it('gives the organiser the address to sign in at Ring, started for their home and in their name', async () => {
    const { h, calls } = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await api(h, sarah, '/api/ring/link', { method: 'POST' });

    expect(await res.json()).toEqual({ url: expect.stringContaining('https://account.ring.com/') });
    expect(calls).toEqual([{ action: 'start', householdId: sarah.householdId, userId: sarah.userId }]);
  });
});

describe('DELETE /api/ring', () => {
  it('disconnects the organiser\'s home', async () => {
    const { h } = await server();
    const sarah = await linkNewOrganiser(h);
    await paste(h, sarah, { token: TOKEN });

    const res = await api(h, sarah, '/api/ring', { method: 'DELETE' });

    expect(await res.json()).toEqual({ linked: false, playgroundAllowed: true });
  });
});

describe('a deployment with no Ring', () => {
  it('says the doorbell cannot be reached, to the organiser, and nothing else', async () => {
    const h = await startServer();
    closers.push(h.close);
    const sarah = await linkNewOrganiser(h);

    const res = await api(h, sarah, '/api/ring');

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'ring_unavailable' });
  });
});

describe('invokedRingLinks — how this server asks the function that holds the tokens', () => {
  it('sends an action and a household, and nothing it was not given', async () => {
    const sent: Record<string, unknown>[] = [];
    const links = invokedRingLinks(async (request) => {
      sent.push(request);
      return { ok: true, linked: false };
    });

    await links.status('hh_a');
    await links.start('hh_a', 'user_sarah');
    await links.playground('hh_a', 'user_sarah', TOKEN);
    await links.disconnect('hh_a');

    expect(sent).toEqual([
      { action: 'status', householdId: 'hh_a' },
      { action: 'start', householdId: 'hh_a', userId: 'user_sarah' },
      { action: 'playground', householdId: 'hh_a', userId: 'user_sarah', token: TOKEN },
      { action: 'disconnect', householdId: 'hh_a' },
    ]);
  });

  it('treats a function that fell over as a failure, not as an answer', async () => {
    for (const broken of [undefined, null, 'oops', { errorMessage: 'Task timed out' }]) {
      expect(await invokedRingLinks(async () => broken).status('hh_a')).toEqual({ ok: false, error: 'failed' });
    }
  });
});

describe('ringLinkView — what a browser is shown of a link', () => {
  it('names the fields it passes on, so a token added to the answer one day would not reach a browser', () => {
    const answer = {
      ok: true,
      linked: true,
      source: 'oauth',
      refreshable: true,
      devices: [{ id: 'ava1.ring.device.X', name: null }],
      access_token: 'must-never-leave',
      accountId: 'ava1.ring.account.A',
    } as RingLinkAnswer;

    const view = ringLinkView(answer);

    expect(view).toMatchObject({ linked: true, source: 'ring', simulated: false, refreshable: true, cameras: ['A Ring device'] });
    expect(JSON.stringify(view)).not.toContain('must-never-leave');
    expect(JSON.stringify(view)).not.toContain('ava1.ring');
  });
});
