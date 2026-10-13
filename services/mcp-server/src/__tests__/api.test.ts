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
  fetch(`${h.base}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${who.tokens.access_token}` } });

async function invite(h: Harness, organiser: Linked, role?: 'neighbour'): Promise<string> {
  const res = await api(h, organiser, '/api/circle/invitations', role
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) }
    : { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}

const JUNE = { name: 'June', email: 'june@example.com', password: 'a neighbourly passphrase' };

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

  it('makes one for a neighbour when asked to, and says which it made', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const post = (body: unknown) => api(h, sarah, '/api/circle/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const neighbour = await post({ role: 'neighbour' });
    expect(neighbour.status).toBe(201);
    expect(await neighbour.json()).toMatchObject({ role: 'neighbour' });

    expect(await (await post({})).json()).toMatchObject({ role: 'family' });
  });

  it('makes nobody an organiser, and nothing it has not heard of', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    for (const role of ['organiser', 'admin', 7]) {
      const res = await api(h, sarah, '/api/circle/invitations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_role' });
    }
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

describe('DELETE /api/televisions/:deviceId', () => {
  it('lets the organiser disconnect a television from the home', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-old', pairedAt: 2, connected: false });

    const res = await api(h, sarah, '/api/televisions/tv-old', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(((await (await api(h, sarah, '/api/circle')).json()) as { televisions: { deviceId: string }[] }).televisions.map((tv) => tv.deviceId)).toEqual(['tv-1']);
  });

  it('is the organiser’s alone', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const res = await api(h, tom, '/api/televisions/tv-1', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await h.store.listTelevisions(sarah.householdId)).toHaveLength(1);
  });

  it('says so when the television is not connected to this home', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);

    const res = await api(h, sarah, '/api/televisions/tv-nobody', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_a_television', message: 'That television is not connected to this home.' });
  });

  it('INV-8: cannot disconnect another home’s television by knowing its id', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const other = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-1', pairedAt: 5, connected: true });

    const res = await api(h, other, '/api/televisions/tv-1', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await h.store.listTelevisions(sarah.householdId)).toHaveLength(1);
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
    const calls: { accessToken: string; code: string; as?: string }[] = [];
    const harness = await startServer({
      claimTelevision: async (accessToken, code, as) => {
        calls.push({ accessToken, code, ...(as ? { as } : {}) });
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

  describe('as a television of one’s own — `as: \'family\'`', () => {
    const FAMILY_REPLY = { status: 200, body: JSON.stringify({ ok: true, deviceId: 'tv-sarah', kind: 'family' }) };

    it('passes it on for an organiser the resident has allowed, and says it was connected as theirs', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      await residentAllows(h, sarah.householdId, sarah.userId);

      const res = await connect(h, sarah, { code: '123 456', as: 'family' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: true, kind: 'family' });
      // INV-8: a token, a code and a kind. There is no household to send.
      expect(calls).toEqual([{ accessToken: sarah.tokens.access_token, code: '123456', as: 'family' }]);
    });

    it('is for a family member the resident has allowed too — not the organiser’s alone', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      const tom = await linkInvited(h, TOM, await invite(h, sarah));
      await residentAllows(h, tom.householdId, tom.userId);

      const res = await connect(h, tom, { code: '123456', as: 'family' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connected: true, kind: 'family' });
      expect(calls).toEqual([{ accessToken: tom.tokens.access_token, code: '123456', as: 'family' }]);
    });

    it('INV-9: is for nobody the resident has not allowed yet — not even the organiser — and the pairing service is not asked', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      const tom = await linkInvited(h, TOM, await invite(h, sarah));

      for (const who of [sarah, tom]) {
        const res = await connect(h, who, { code: '123456', as: 'family' });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'not_allowed_yet', message: 'You can connect a television of your own once Margaret has allowed you.' });
      }
      expect(calls).toEqual([]);
    });

    it('is not for a neighbour, who is shown nothing', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      const june = await linkInvited(h, JUNE, await invite(h, sarah, 'neighbour'));
      await residentAllows(h, june.householdId, june.userId);

      const res = await connect(h, june, { code: '123456', as: 'family' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_for_a_neighbour', message: 'A neighbour cannot connect a television.' });
      expect(calls).toEqual([]);
    });

    it('says so, in the resident’s own words for it, to someone they turned down or who was removed', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      const tom = await linkInvited(h, TOM, await invite(h, sarah));
      await h.store.setMemberStatus(tom.householdId, tom.userId, 'declined', Date.now());

      const res = await connect(h, tom, { code: '123456', as: 'family' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_allowed_yet', message: 'Margaret chose not to share this with you.' });
      expect(calls).toEqual([]);
    });

    it('refuses a kind it has not heard of without bothering the pairing service', async () => {
      const { h, calls } = await serverWithPairing(FAMILY_REPLY);
      const sarah = await linkNewOrganiser(h);
      await residentAllows(h, sarah.householdId, sarah.userId);

      for (const as of ['resident', 'FAMILY', '', null, 7, ['family']]) {
        const res = await connect(h, sarah, { code: '123456', as });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'bad_kind' });
      }
      expect(calls).toEqual([]);
    });

    it.each([
      [403, 'not_allowed_yet', 'You can connect a television of your own once Margaret has allowed you.'],
      [400, 'bad_kind', 'This Wick cannot connect a television of that kind.'],
      [409, 'television_in_another_home', 'That television belongs to another home. It has to be disconnected there first.'],
    ])('says what the pairing service refused in words: %i %s', async (status, body, message) => {
      const { h } = await serverWithPairing({ status, body });
      const sarah = await linkNewOrganiser(h);
      await residentAllows(h, sarah.householdId, sarah.userId);

      const res = await connect(h, sarah, { code: '123456', as: 'family' });

      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: body, message });
    });

    it('says a television is somebody’s own only when the pairing service says it connected it as one', async () => {
      // A pairing service that has not heard of kinds connects the resident's television, and says no kind.
      const { h } = await serverWithPairing({ status: 200, body: JSON.stringify({ ok: true, deviceId: 'tv-1' }) });
      const sarah = await linkNewOrganiser(h);
      await residentAllows(h, sarah.householdId, sarah.userId);

      const res = await connect(h, sarah, { code: '123456', as: 'family' });

      expect(await res.json()).toEqual({ connected: true });
    });

    it('leaves the resident’s own television as it was: no kind sent, none answered', async () => {
      const { h, calls } = await serverWithPairing({ status: 200, body: JSON.stringify({ ok: true, deviceId: 'tv-1' }) });
      const sarah = await linkNewOrganiser(h);

      const res = await connect(h, sarah, { code: '123456' });

      expect(await res.json()).toEqual({ connected: true });
      expect(calls).toEqual([{ accessToken: sarah.tokens.access_token, code: '123456' }]);
    });
  });
});

describe('family televisions — a member’s own, listed apart from the resident’s', () => {
  async function home() {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    await residentAllows(h, sarah.householdId, sarah.userId);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    h.store.addTelevision(sarah.householdId, { deviceId: 'tv-margaret', pairedAt: 5, connected: true });
    h.store.addFamilyTelevision(sarah.householdId, { deviceId: 'tv-sarah', userId: sarah.userId, pairedAt: 7 });
    h.store.addFamilyTelevision(sarah.householdId, { deviceId: 'tv-tom', userId: tom.userId, pairedAt: 9 });
    return { h, sarah, tom };
  }
  type Circle = { televisions: { deviceId: string }[]; familyTelevisions: { deviceId: string; userId: string; memberName: string; pairedAt?: number; yours: boolean }[] };
  const circleOf = async (h: Harness, who: Linked) => (await (await api(h, who, '/api/circle')).json()) as Circle;

  it('GET /api/circle lists them on their own, by whose they are — never among the resident’s televisions', async () => {
    const { h, sarah, tom } = await home();

    const seen = await circleOf(h, tom);

    expect(seen.televisions.map((tv) => tv.deviceId)).toEqual(['tv-margaret']);
    expect(seen.familyTelevisions).toEqual([
      { deviceId: 'tv-sarah', userId: sarah.userId, memberName: 'Sarah', pairedAt: 7, yours: false },
      { deviceId: 'tv-tom', userId: tom.userId, memberName: 'Tom', pairedAt: 9, yours: true },
    ]);
  });

  it('INV-9: shows none of them to an organiser the resident has not allowed yet', async () => {
    const h = await server();
    const sarah = await linkNewOrganiser(h);
    const tom = await linkInvited(h, TOM, await invite(h, sarah));
    await residentAllows(h, tom.householdId, tom.userId);
    h.store.addFamilyTelevision(sarah.householdId, { deviceId: 'tv-tom', userId: tom.userId, pairedAt: 9 });

    expect((await circleOf(h, sarah)).familyTelevisions).toEqual([]);
    expect((await circleOf(h, tom)).familyTelevisions).toHaveLength(1);
  });

  it('DELETE /api/family-televisions/:deviceId lets a member disconnect their own', async () => {
    const { h, sarah, tom } = await home();

    const res = await api(h, tom, '/api/family-televisions/tv-tom', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await circleOf(h, sarah)).familyTelevisions.map((tv) => tv.deviceId)).toEqual(['tv-sarah']);
    // The resident's own television is not this route's to touch.
    expect(await h.store.listTelevisions(sarah.householdId)).toHaveLength(1);
  });

  it('lets the organiser disconnect anyone’s', async () => {
    const { h, sarah } = await home();

    const res = await api(h, sarah, '/api/family-televisions/tv-tom', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect((await circleOf(h, sarah)).familyTelevisions.map((tv) => tv.deviceId)).toEqual(['tv-sarah']);
  });

  it('does not let one family member disconnect another’s', async () => {
    const { h, sarah, tom } = await home();

    const res = await api(h, tom, '/api/family-televisions/tv-sarah', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'not_your_television',
      message: 'Only the person whose television it is, or the person who set this home up, can disconnect it.',
    });
    expect(await h.store.listFamilyTelevisions(sarah.householdId)).toHaveLength(2);
  });

  it('is not a way to disconnect the resident’s television: that one is not a family television', async () => {
    const { h, sarah } = await home();

    const res = await api(h, sarah, '/api/family-televisions/tv-margaret', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_a_television', message: 'That television is not connected to this home.' });
    expect(await h.store.listTelevisions(sarah.householdId)).toHaveLength(1);
  });

  it('INV-8: cannot disconnect another home’s family television by knowing its id', async () => {
    const { h, sarah } = await home();
    const other = await linkNewOrganiser(h, { name: 'Priya', email: 'priya@example.com', password: 'another long passphrase' }, 'Asha');

    const res = await api(h, other, '/api/family-televisions/tv-tom', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await h.store.listFamilyTelevisions(sarah.householdId)).toHaveLength(2);
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
