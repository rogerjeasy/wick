/**
 * A person's own data, end to end over a real socket: signing out ends the
 * tokens and the sign-in cookie, the export holds what Wick holds about them
 * and no way in, and deleting the account takes it all — and never leaves a
 * home without the person who set it up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RingLinkAnswer, RingLinks } from '../accounts/apiRouter.js';
import type { PhotoObjects } from '../photos/objects.js';
import type { AppDeps } from '../server.js';
import {
  Browser,
  beginAuthorize,
  exchangeCode,
  linkInvited,
  linkNewOrganiser,
  registerClient,
  residentAllows,
  SARAH,
  startServer,
  TOM,
  type Harness,
  type Linked,
  type Tokens,
} from './harness.js';
import { createMemoryTable, type MemoryTable } from './memoryTable.js';
import { putPublicKey, token as deviceToken } from '../accounts/__tests__/familyTvWorld.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface World {
  readonly h: Harness;
  readonly table: MemoryTable;
  readonly removedPictures: string[];
  readonly disconnected: string[];
}

async function world(overrides: Partial<AppDeps> & { ringAnswer?: RingLinkAnswer } = {}): Promise<World> {
  const table = createMemoryTable();
  const removedPictures: string[] = [];
  const disconnected: string[] = [];
  const photos: PhotoObjects = {
    put: async () => {},
    remove: async (householdId, photoId) => void removedPictures.push(`${householdId}/${photoId}`),
  };
  const answer = overrides.ringAnswer ?? { ok: true, linked: false };
  const ringLinks: RingLinks = {
    status: async () => answer,
    start: async () => answer,
    complete: async () => answer,
    playground: async () => answer,
    disconnect: async (householdId) => {
      disconnected.push(householdId);
      return answer;
    },
  };
  const h = await startServer({
    ddb: table.ddb,
    ringLinks,
    photos: { objects: photos, moderate: async () => ({ ok: true }) } as unknown as AppDeps['photos'],
    ...overrides,
  });
  closers.push(h.close);
  return { h, table, removedPictures, disconnected };
}

const bearer = (tokens: Tokens) => ({ authorization: `Bearer ${tokens.access_token}` });

const call = (h: Harness, who: Linked | Tokens, path: string, init: RequestInit = {}) => {
  const tokens = 'tokens' in who ? who.tokens : who;
  return fetch(`${h.base}${path}`, { ...init, headers: { ...bearer(tokens), ...(init.headers ?? {}) } });
};

const deleteAccount = (h: Harness, who: Linked | Tokens, body: Record<string, unknown>) =>
  call(h, who, '/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function invite(h: Harness, organiser: Linked): Promise<string> {
  const res = await call(h, organiser, '/api/circle/invitations', { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}

/** Sarah sets a home up for Margaret; Tom joins it and Margaret allows him. */
async function sarahAndTom(w: World): Promise<{ sarah: Linked; tom: Linked }> {
  const sarah = await linkNewOrganiser(w.h);
  await residentAllows(w.h, sarah.householdId, sarah.userId);
  const tom = await linkInvited(w.h, TOM, await invite(w.h, sarah));
  await residentAllows(w.h, tom.householdId, tom.userId);
  return { sarah, tom };
}

/**
 * A note on her television, as send_note_to_tv queues it — with `sentBy`, the
 * writer's id that egress.ts keeps on the row (PR #69), or without it, as a
 * note sent before that was kept — answered as note-reply.mjs records it.
 */
function putNote(table: MemoryTable, householdId: string, fromName: string, message: string, reply?: string, sentBy?: string): void {
  const id = `note-${fromName}-${message.length}-${sentBy ?? 'nobody'}`;
  const queued = {
    id,
    urgency: 'DEFERRED',
    queuedAt: 1_790_000_000_000,
    shownCount: 1,
    card: { type: 'MESSAGE', id, householdId, correlationId: id, createdAt: 1_790_000_000_000, actions: [], fromName, transcript: message, suggestedReplies: ['Yes, please do.', 'Another day would be better.', 'Not right now.'] },
  };
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${id}` },
    data: { S: JSON.stringify(queued) },
    ...(reply ? { replyText: { S: reply }, repliedAt: { N: '1790000100000' } } : {}),
    ...(sentBy ? { sentBy: { S: sentBy } } : {}),
  });
}

function putPicture(table: MemoryTable, householdId: string, photoId: string, sentBy: string, seen: boolean): void {
  table.put({
    pk: { S: `HH#${householdId}` },
    sk: { S: `PHOTO#${photoId}` },
    photoId: { S: photoId },
    sentBy: { S: sentBy },
    sentByName: { S: 'Tom' },
    sentAt: { N: '1790000000000' },
    ...(seen ? { seenAt: { N: '1790000200000' } } : {}),
  });
}

describe('signing out', () => {
  it('revokes the app’s access and refresh tokens at /revoke, for the public client they were issued to', async () => {
    const { h } = await world();
    const sarah = await linkNewOrganiser(h);
    const revoke = (token: string, clientId: string) =>
      fetch(`${h.base}/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: clientId }),
      });

    // Another app that knows the token cannot end it: answered 200, and nothing changes.
    const stranger = await registerClient(h.base);
    expect((await revoke(sarah.tokens.access_token, stranger.clientId)).status).toBe(200);
    expect((await call(h, sarah, '/api/me')).status).toBe(200);

    expect((await revoke(sarah.tokens.access_token, sarah.client.clientId)).status).toBe(200);
    expect((await revoke(sarah.tokens.refresh_token, sarah.client.clientId)).status).toBe(200);

    expect((await call(h, sarah, '/api/me')).status).toBe(401);
    const refreshed = await fetch(`${h.base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: sarah.tokens.refresh_token, client_id: sarah.client.clientId }),
    });
    expect(refreshed.status).toBe(400);
  });

  it('forgets the browser’s sign-in at /account/sign-out, and goes back only to an address the app registered', async () => {
    const { h } = await world();
    const sarah = await linkNewOrganiser(h);

    // Signed in: the next sign-in on this browser would go straight to Approve.
    const before = await sarah.browser.get(`/account?tx=${await beginAuthorize(sarah.browser, sarah.client)}`);
    expect(await before.text()).toContain('Approve');

    const out = await sarah.browser.get(
      `/account/sign-out?client_id=${encodeURIComponent(sarah.client.clientId)}&redirect_uri=${encodeURIComponent(sarah.client.redirectUri)}`,
    );
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe(sarah.client.redirectUri);
    expect(out.headers.getSetCookie().join(';')).toMatch(/wick_session=;.*Max-Age=0/);

    const after = await sarah.browser.get(`/account?tx=${await beginAuthorize(sarah.browser, sarah.client)}`);
    expect(await after.text()).toContain('Sign in');
    expect(await (await sarah.browser.get(`/account?tx=${await beginAuthorize(sarah.browser, sarah.client)}`)).text()).not.toContain('Approve');

    // Anywhere else is not somewhere this page sends a browser.
    const elsewhere = await new Browser(h.base).get(`/account/sign-out?client_id=${sarah.client.clientId}&redirect_uri=${encodeURIComponent('https://example.com/')}`);
    expect(elsewhere.status).toBe(200);
    expect(await elsewhere.text()).toContain('You are signed out');
  });

  it('says on every answer that it is not to be framed or sniffed, and sends no referrer', async () => {
    const { h } = await world();
    const res = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // Over plain HTTP, as here, a browser is not told to insist on HTTPS.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('the export', () => {
  it('is a file of everything held about the person, with no code, token or browser address in it', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    await invite(w.h, sarah);
    putNote(w.table, tom.householdId, 'Tom', 'Shall I come on Saturday?', 'Yes, please do.', tom.userId);
    putNote(w.table, tom.householdId, 'Sarah', 'Not Tom’s note', undefined, sarah.userId);
    putPicture(w.table, tom.householdId, 'p-tom', tom.userId, true);
    putPicture(w.table, tom.householdId, 'p-sarah', sarah.userId, false);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/secret-capability';
    // The deployment's public signing key, as generate-push-keys.sh writes it: without one nothing is offered.
    w.table.put({ pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: 'BPublicKey' } });
    await call(w.h, tom, '/api/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
    });

    const res = await call(w.h, tom, '/api/account/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="wick-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    const file = JSON.parse(text);

    expect(file.format).toBe('wick-my-data/1');
    expect(file.account).toMatchObject({ name: 'Tom', email: TOM.email, guest: false });
    expect(file.circles).toEqual([expect.objectContaining({ residentName: 'Margaret', nameInTheCircle: 'Tom', role: 'family', status: 'allowed' })]);
    expect(file.notesSent).toEqual([expect.objectContaining({ message: 'Shall I come on Saturday?', reply: expect.objectContaining({ text: 'Yes, please do.' }) })]);
    expect(file.picturesSent).toEqual([expect.objectContaining({ seen: true })]);
    expect(file.browsersToNudge).toEqual([expect.objectContaining({ pushService: 'https://fcm.googleapis.com' })]);
    expect(file.linkedApps.map((a: { token: string }) => a.token).sort()).toEqual(['access', 'refresh']);
    expect(file.signIns).toHaveLength(1);
    expect(file.invitationsSent).toEqual([]);

    // No way in: not the token it was asked with, not the push address, not the user id the index is keyed on.
    expect(text).not.toContain(tom.tokens.access_token);
    expect(text).not.toContain(tom.tokens.refresh_token);
    expect(text).not.toContain('secret-capability');

    // The organiser's invitations are in hers, without their codes.
    const hers = JSON.parse(await (await call(w.h, sarah, '/api/account/export')).text());
    expect(hers.invitationsSent).toHaveLength(2);
    expect(hers.invitationsSent[0]).toEqual(expect.objectContaining({ role: 'family', residentName: 'Margaret' }));
    expect(Object.keys(hers.invitationsSent[0])).not.toContain('code');
  });

  it('gives each of two members with the same name only the notes they wrote, and a note with no writer on record to nobody', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    // A second "Tom" in the same circle: the name on a note says nothing about whose it is.
    const otherTom = await linkInvited(w.h, { name: 'Tom', email: 'tom.two@example.com', password: 'another passphrase' }, await invite(w.h, sarah));
    await residentAllows(w.h, otherTom.householdId, otherTom.userId);
    putNote(w.table, tom.householdId, 'Tom', 'From the first Tom', 'Yes, please do.', tom.userId);
    putNote(w.table, tom.householdId, 'Tom', 'From the second Tom, longer', 'Another day would be better.', otherTom.userId);
    putNote(w.table, tom.householdId, 'Tom', 'Sent before writers were kept', 'Thank you!');

    const exportOf = async (who: Linked) => JSON.parse(await (await call(w.h, who, '/api/account/export')).text()) as { notesSent: { message: string; reply?: { text: string } }[]; about: string };
    const first = await exportOf(tom);
    const second = await exportOf(otherTom);
    expect(first.notesSent.map((n) => [n.message, n.reply?.text])).toEqual([['From the first Tom', 'Yes, please do.']]);
    expect(second.notesSent.map((n) => [n.message, n.reply?.text])).toEqual([['From the second Tom, longer', 'Another day would be better.']]);
    // The note with no writer on record is in nobody's file — not Sarah's either — and the file says why.
    for (const file of [first, second, await exportOf(sarah)]) {
      expect(JSON.stringify(file)).not.toContain('Sent before writers were kept');
      expect(file.about).toContain('cannot be told for certain whose it is');
    }
  });

  it('leaves out the resident’s replies and a picture’s seen for somebody still waiting for her', async () => {
    const w = await world();
    const sarah = await linkNewOrganiser(w.h);
    await residentAllows(w.h, sarah.householdId, sarah.userId);
    const tom = await linkInvited(w.h, TOM, await invite(w.h, sarah));
    // Tom is pending: whatever is on the rows, nothing she said is his yet.
    putNote(w.table, tom.householdId, 'Tom', 'Hello', 'Yes, please do.', tom.userId);
    putPicture(w.table, tom.householdId, 'p-tom', tom.userId, true);

    const file = JSON.parse(await (await call(w.h, tom, '/api/account/export')).text());
    expect(file.circles[0].status).toBe('pending');
    expect(file.notesSent[0]).not.toHaveProperty('reply');
    expect(file.picturesSent[0]).not.toHaveProperty('seen');
  });

  it('leaves out what the resident said back while she does not allow the person', async () => {
    const w = await world();
    const { tom } = await sarahAndTom(w);
    putNote(w.table, tom.householdId, 'Tom', 'Shall I come?', 'Yes, please do.', tom.userId);
    putPicture(w.table, tom.householdId, 'p-tom', tom.userId, true);
    await w.h.store.setMemberStatus(tom.householdId, tom.userId, 'removed', Date.now());

    const file = JSON.parse(await (await call(w.h, tom, '/api/account/export')).text());
    expect(file.notesSent[0].message).toBe('Shall I come?');
    expect(file.notesSent[0]).not.toHaveProperty('reply');
    expect(file.picturesSent[0]).not.toHaveProperty('seen');
  });
});

describe('deleting an account', () => {
  it('asks for the password again, and with it takes the person’s account, place in the circle and every token', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    w.h.store.addFamilyTelevision(tom.householdId, { deviceId: 'toms-tv', userId: tom.userId });
    putNote(w.table, tom.householdId, 'Tom', 'A note of Tom’s', undefined, tom.userId);
    putNote(w.table, tom.householdId, 'Sarah', 'A note of Sarah’s, longer', undefined, sarah.userId);
    w.table.put({ pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: 'BPublicKey' } });
    await call(w.h, tom, '/api/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/toms-phone', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } }),
    });
    expect(w.table.rows(`USER#${tom.userId}`)).toHaveLength(1);

    const plan = await (await call(w.h, tom, '/api/account/deletion')).json();
    expect(plan).toEqual({ guest: false, needsPassword: true, homes: [expect.objectContaining({ residentName: 'Margaret', closes: false, others: 0 })] });

    expect((await deleteAccount(w.h, tom, {})).status).toBe(400);
    const wrong = await deleteAccount(w.h, tom, { password: 'not it' });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe('wrong_password');
    expect(await w.h.store.getUser(tom.userId)).toBeDefined();

    const res = await deleteAccount(w.h, tom, { password: TOM.password });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect(await w.h.store.getUser(tom.userId)).toBeUndefined();
    expect(await w.h.store.getMembership(tom.householdId, tom.userId)).toBeUndefined();
    expect(await w.h.store.listFamilyTelevisions(tom.householdId)).toEqual([]);
    expect(await w.h.store.listOwnedRecords(tom.userId)).toEqual([]);
    expect(w.h.store.forgottenVisits).toContainEqual({ householdId: tom.householdId, userId: tom.userId });
    // No browser of his is kept to be nudged.
    expect(w.table.rows(`USER#${tom.userId}`)).toEqual([]);
    // His note stays the home's, with no writer on record; Sarah's keeps hers.
    const notes = w.table.rows(`HH#${tom.householdId}`).filter((row) => row.sk?.S?.startsWith('CARD#note-'));
    const writerOf = (start: string) => notes.find((row) => row.data?.S?.includes(start))?.sentBy?.S;
    expect(notes).toHaveLength(2);
    expect(writerOf('A note of Tom’s')).toBeUndefined();
    expect(writerOf('A note of Sarah’s')).toBe(sarah.userId);
    // His tokens end with it, and so does his sign-in at Cognito.
    expect((await call(w.h, tom, '/api/me')).status).toBe(401);
    await expect(w.h.deps.identity.signIn({ email: TOM.email, password: TOM.password })).rejects.toMatchObject({ code: 'wrong_credentials' });

    // The home he was in is untouched, and so is its organiser.
    expect((await call(w.h, sarah, '/api/me')).status).toBe(200);
    expect(w.disconnected).toEqual([]);
  });

  it('refuses to leave a home without the person who set it up, in a sentence, until they choose to close it', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    w.h.store.addTelevision(sarah.householdId, { deviceId: 'her-tv', connected: true });
    putNote(w.table, sarah.householdId, 'Tom', 'Hello', undefined, tom.userId);
    putPicture(w.table, sarah.householdId, 'p-1', tom.userId, false);
    w.table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'MANTEL#p-1' } });

    const plan = (await (await call(w.h, sarah, '/api/account/deletion')).json()) as { homes: unknown[] };
    expect(plan.homes).toEqual([expect.objectContaining({ residentName: 'Margaret', closes: true, others: 1 })]);

    const refused = await deleteAccount(w.h, sarah, { password: SARAH.password });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; message: string };
    expect(body.error).toBe('closes_a_home');
    expect(body.message).toContain('Margaret’s television is disconnected');
    expect(body.message).toContain('a home is never left without the person who set it up');
    // Nothing went.
    expect(await w.h.store.getUser(sarah.userId)).toBeDefined();
    expect(w.table.rows(`HH#${sarah.householdId}`)).not.toEqual([]);
    expect(w.disconnected).toEqual([]);

    const closed = await deleteAccount(w.h, sarah, { password: SARAH.password, closeHomes: true });
    expect(closed.status).toBe(200);

    expect(w.disconnected).toEqual([sarah.householdId]);
    expect(w.removedPictures).toEqual([`${sarah.householdId}/p-1`]);
    expect(w.table.rows(`HH#${sarah.householdId}`)).toEqual([]);
    expect(await w.h.store.getHousehold(sarah.householdId)).toBeUndefined();
    expect(await w.h.store.listTelevisions(sarah.householdId)).toEqual([]);
    expect(await w.h.store.listMembers(sarah.householdId)).toEqual([]);
    expect(await w.h.store.getUser(sarah.userId)).toBeUndefined();
    // Tom keeps his account, and the home he was in is simply not there for him any more.
    expect(await w.h.store.getUser(tom.userId)).toBeDefined();
    expect((await call(w.h, tom, '/api/me')).status).toBe(404);
  });

  it('closes the home when Margaret stops Wick from her own television, and Sarah keeps her account', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    putPublicKey(w.table);
    w.h.store.addTelevision(sarah.householdId, { deviceId: 'her-tv', connected: true });
    w.table.put({ pk: { S: `HH#${sarah.householdId}` }, sk: { S: 'DEV#her-tv' } });
    putPicture(w.table, sarah.householdId, 'p-1', tom.userId, false);

    // The test's clock is the real one: the token is signed to be good now.
    const her = deviceToken({ deviceId: 'her-tv', householdId: sarah.householdId, proof: 'pairing' }, { exp: Math.floor(Date.now() / 1000) + 3600 });
    const stop = (body: unknown) =>
      fetch(`${w.h.base}/tv/stop`, { method: 'POST', headers: { authorization: `Bearer ${her}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect((await stop({})).status).toBe(400);
    expect(await w.h.store.getHousehold(sarah.householdId)).toBeDefined();

    const res = await stop({ confirm: 'stop' });
    expect(res.status).toBe(200);
    expect(w.disconnected).toEqual([sarah.householdId]);
    expect(w.removedPictures).toEqual([`${sarah.householdId}/p-1`]);
    expect(w.table.rows(`HH#${sarah.householdId}`)).toEqual([]);
    expect(await w.h.store.getHousehold(sarah.householdId)).toBeUndefined();
    expect(await w.h.store.listMembers(sarah.householdId)).toEqual([]);
    // Their accounts are theirs: only the home is gone.
    expect(await w.h.store.getUser(sarah.userId)).toBeDefined();
    expect(await w.h.store.getUser(tom.userId)).toBeDefined();
    // Her family's app is told what happened, in words, not that something went wrong.
    for (const who of [sarah, tom]) {
      const me = await call(w.h, who, '/api/me');
      expect(me.status).toBe(410);
      expect(await me.json()).toMatchObject({ error: 'home_closed', residentName: 'Margaret', message: expect.stringContaining('Margaret has stopped Wick.') });
    }
    // And a television already disconnected can close nothing again.
    expect((await stop({ confirm: 'stop' })).status).toBe(401);
  });

  it('deletes nothing when the doorbell cannot be disconnected', async () => {
    const w = await world({ ringAnswer: { ok: false, error: 'failed' } });
    const sarah = await linkNewOrganiser(w.h);

    const res = await deleteAccount(w.h, sarah, { password: SARAH.password, closeHomes: true });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('doorbell_unavailable');
    expect(await w.h.store.getUser(sarah.userId)).toBeDefined();
    expect(await w.h.store.getHousehold(sarah.householdId)).toBeDefined();
    await expect(w.h.deps.identity.signIn({ email: SARAH.email, password: SARAH.password })).resolves.toMatchObject({ name: 'Sarah' });
  });

  it('finishes a deletion that stopped after the Cognito user was gone, without the password', async () => {
    const w = await world();
    const sarah = await linkNewOrganiser(w.h);
    // As a first try leaves it: the password checked, the user deleted at Cognito, then a failure.
    await w.h.store.putRecord('DELETING', sarah.userId, { at: Date.now() }, Date.now() + 60_000);
    await w.h.deps.identity.deleteAccount({ email: SARAH.email, password: SARAH.password });

    const res = await deleteAccount(w.h, sarah, { closeHomes: true });
    expect(res.status).toBe(200);
    expect(await w.h.store.getUser(sarah.userId)).toBeUndefined();
    expect(await w.h.store.getRecord('DELETING', sarah.userId)).toBeUndefined();
  });

  it('takes a demo guest and their demo home with no password, once they choose to close it', async () => {
    const w = await world({ demoAccounts: true });
    const browser = new Browser(w.h.base);
    const client = await registerClient(w.h.base);
    const tx = await beginAuthorize(browser, client, { demo: '1' });
    const res = await browser.get(`/account?tx=${tx}`);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    const tokens = (await (await exchangeCode(w.h.base, client, code)).json()) as Tokens;

    const plan = await (await call(w.h, tokens, '/api/account/deletion')).json();
    expect(plan).toEqual({ guest: true, needsPassword: false, homes: [expect.objectContaining({ closes: true, simulated: true, others: 0 })] });

    expect((await deleteAccount(w.h, tokens, {})).status).toBe(409);
    expect((await deleteAccount(w.h, tokens, { closeHomes: true })).status).toBe(200);
    expect((await call(w.h, tokens, '/api/me')).status).toBe(401);
  });

  it('is about the token’s person only: a body cannot name somebody else', async () => {
    const w = await world();
    const { sarah, tom } = await sarahAndTom(w);
    const res = await deleteAccount(w.h, tom, { password: TOM.password, userId: sarah.userId, householdId: sarah.householdId });
    expect(res.status).toBe(200);
    expect(await w.h.store.getUser(sarah.userId)).toBeDefined();
    expect(await w.h.store.getMembership(sarah.householdId, sarah.userId)).toBeDefined();
  });

  it('needs a sign-in', async () => {
    const { h } = await world();
    expect((await fetch(`${h.base}/api/account/export`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/account`, { method: 'DELETE' })).status).toBe(401);
  });
});
