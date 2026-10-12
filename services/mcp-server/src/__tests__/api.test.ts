import { afterEach, describe, expect, it } from 'vitest';
import { linkInvited, linkNewOrganiser, residentAllows, startServer, TOM, type Harness, type Linked } from './harness.js';
import { createMemoryTable } from './memoryTable.js';

const closers: (() => Promise<void>)[] = [];

async function server(): Promise<Harness> {
  const harness = await startServer();
  closers.push(harness.close);
  return harness;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const api = (h: Harness, who: Linked, path: string, init: RequestInit = {}) =>
  fetch(`${h.base}${path}`, { ...init, headers: { authorization: `Bearer ${who.tokens.access_token}` } });

async function invite(h: Harness, organiser: Linked): Promise<string> {
  const res = await api(h, organiser, '/api/circle/invitations', { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}

describe('GET /api/circle', () => {
  it('shows the organiser their circle while they wait, so they can see the television connect', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const res = await api(h, sarah, '/api/circle');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      household: { residentName: 'Margaret' },
      members: [{ name: 'Sarah', role: 'organiser', status: 'pending', you: true }],
      televisions: [{ deviceId: 'tv-1', connected: true }],
    });
  });

  it('INV-9: shows an invited person nothing about the circle until the resident allows them', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));

    const waiting = await api(h, tom, '/api/circle');
    expect(waiting.status).toBe(403);
    expect(JSON.stringify(await waiting.json())).not.toContain('Sarah');

    await residentAllows(h, tom.householdId, tom.userId);
    const allowed = await api(h, tom, '/api/circle');
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { members: unknown[] }).members).toHaveLength(2);
  });

  it('is cross-origin readable: the family app is served from another origin', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await api(h, sarah, '/api/me');

    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('invitations', () => {
  it('lets the organiser make one, good for a week', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const before = Date.now();

    const res = await api(h, sarah, '/api/circle/invitations', { method: 'POST' });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { code: string; expiresAt: number };
    expect(body.code.length).toBeGreaterThanOrEqual(16);
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000);
  });

  it('refuses anyone else, even once allowed', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);

    const res = await api(h, tom, '/api/circle/invitations', { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'not_organiser' });
  });
});

describe('removing someone', () => {
  it('takes them out of the circle at once: their token stops answering questions about the home', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    expect((await api(h, tom, '/api/circle')).status).toBe(200);

    const removed = await api(h, sarah, `/api/circle/members/${tom.userId}`, { method: 'DELETE' });

    expect(removed.status).toBe(204);
    expect((await api(h, tom, '/api/circle')).status).toBe(403);
    expect(await (await api(h, tom, '/api/me')).json()).toMatchObject({ membership: { status: 'removed' } });
  });

  it('is not something a family member can do to the organiser', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);

    const res = await api(h, tom, `/api/circle/members/${sarah.userId}`, { method: 'DELETE' });

    expect(res.status).toBe(403);
  });
});

describe('INV-8: one household per token, and no way to name another', () => {
  it('answers each person about their own home only', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const other = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');

    const mine = (await (await api(h, sarah, '/api/me')).json()) as { household: { residentName: string } };
    const theirs = (await (await api(h, other, '/api/me')).json()) as { household: { residentName: string } };

    expect(mine.household.residentName).toBe('Margaret');
    expect(theirs.household.residentName).toBe('Asha');
    expect(sarah.householdId).not.toBe(other.householdId);
  });

  it('cannot remove a member of another household by knowing their id', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const other = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');

    const res = await api(h, other, `/api/circle/members/${sarah.userId}`, { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await h.store.getMembership(sarah.householdId, sarah.userId)).toMatchObject({ status: 'pending' });
  });
});

describe('POST /api/televisions — connecting a television with its six-digit code', () => {
  async function serverWithPairing(reply: { status: number; body: string }) {
    const calls: { accessToken: string; code: string }[] = [];
    const harness = await startServer({
      claimTelevision: async (accessToken, code) => {
        calls.push({ accessToken, code });
        return reply;
      },
    });
    closers.push(harness.close);
    return { h: harness, calls };
  }

  const connect = (h: Harness, who: Linked, body: unknown) =>
    fetch(`${h.base}/api/televisions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who.tokens.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('hands the code to the pairing service with the caller’s own token, so that service decides who they are', async () => {
    const { h, calls } = await serverWithPairing({ status: 200, body: JSON.stringify({ ok: true, deviceId: 'tv-1' }) });
    const sarah = await linkNewOrganiser(h);

    const res = await connect(h, sarah, { code: '123 456' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });
    expect(calls).toEqual([{ accessToken: sarah.tokens.access_token, code: '123456' }]);
  });

  it('refuses a code that is not six digits without bothering the pairing service', async () => {
    const { h, calls } = await serverWithPairing({ status: 200, body: '{}' });
    const sarah = await linkNewOrganiser(h);

    const res = await connect(h, sarah, { code: '12ab' });

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each([
    [404, 'unknown_or_expired_code', 'That code is not on a television right now. Check the six digits.'],
    [410, 'code_expired', 'That code has expired. The television is showing a new one.'],
    [409, 'already_claimed', 'That code has already been used.'],
    [409, 'television_in_another_home', 'That television belongs to another home. It has to be disconnected there first.'],
    [403, 'only_the_organiser_can_connect_a_television', 'Only the person who set this home up can connect a television.'],
  ])('says what went wrong in words: %i %s', async (status, body, message) => {
    const { h } = await serverWithPairing({ status, body });
    const sarah = await linkNewOrganiser(h);

    const res = await connect(h, sarah, { code: '123456' });

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: body, message });
  });

  it('never passes on something the pairing service said that it does not recognise', async () => {
    const { h } = await serverWithPairing({ status: 500, body: 'AccessDeniedException: arn:aws:iam::123456789012:role/x' });
    const sarah = await linkNewOrganiser(h);

    const res = await connect(h, sarah, { code: '123456' });

    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('arn:aws');
  });
});

describe('GET /api/me — where to find a television to try it on', () => {
  it('points at the virtual television when the deployment has one, so nobody needs a Fire TV to see the resident’s side', async () => {
    const h = await startServer({ virtualTelevisionUrl: 'https://ops.example/device.html' });
    closers.push(h.close);
    const sarah = await linkNewOrganiser(h);

    const body = (await (await api(h, sarah, '/api/me')).json()) as { virtualTelevisionUrl?: string; user: { guest: boolean } };

    expect(body.virtualTelevisionUrl).toBe('https://ops.example/device.html');
    expect(body.user.guest).toBe(false);
  });

  it('says nothing about one when there is none', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    expect(await (await api(h, sarah, '/api/me')).json()).not.toHaveProperty('virtualTelevisionUrl');
  });
});

describe('/api/push — being told when the family app is closed', () => {
  const BROWSER = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
  const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
  const send = (h: Harness, who: Linked, init: RequestInit) =>
    fetch(`${h.base}/api/push`, { ...init, headers: { authorization: `Bearer ${who.tokens.access_token}`, 'content-type': 'application/json' } });

  async function withPushKeys() {
    const table = createMemoryTable();
    table.put({ pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: 'BPublicVapidKey' } });
    const h = await startServer({ ddb: table.ddb });
    closers.push(h.close);
    return { h, table };
  }

  it('says it is not available in a deployment with no push keys, and stores nothing', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    expect(await (await api(h, sarah, '/api/push')).json()).toEqual({ available: false });
    expect((await send(h, sarah, json(BROWSER))).status).toBe(503);
  });

  it('hands the page the public key it subscribes with', async () => {
    const { h } = await withPushKeys();
    const sarah = await linkNewOrganiser(h);

    expect(await (await api(h, sarah, '/api/push')).json()).toEqual({ available: true, publicKey: 'BPublicVapidKey' });
  });

  it('keeps a browser under the person the token is for, and forgets it again', async () => {
    const { h, table } = await withPushKeys();
    const sarah = await linkNewOrganiser(h);

    expect((await send(h, sarah, json(BROWSER))).status).toBe(204);
    expect(table.rows(`USER#${sarah.userId}`).map((row) => row.endpoint?.S)).toEqual([BROWSER.endpoint]);

    expect((await send(h, sarah, json({ endpoint: BROWSER.endpoint }, 'DELETE'))).status).toBe(204);
    expect(table.rows(`USER#${sarah.userId}`).filter((row) => row.sk?.S?.startsWith('PUSH#'))).toEqual([]);
  });

  it('refuses an address that is not a browser push service', async () => {
    const { h, table } = await withPushKeys();
    const sarah = await linkNewOrganiser(h);

    const res = await send(h, sarah, json({ ...BROWSER, endpoint: 'https://169.254.169.254/latest/meta-data/' }));

    expect(res.status).toBe(400);
    expect(table.rows(`USER#${sarah.userId}`).filter((row) => row.sk?.S?.startsWith('PUSH#'))).toEqual([]);
  });

  it('is for someone signed in', async () => {
    const { h } = await withPushKeys();

    expect((await fetch(`${h.base}/api/push`)).status).toBe(401);
  });
});
